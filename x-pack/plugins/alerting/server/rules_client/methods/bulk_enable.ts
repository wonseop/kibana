/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import pMap from 'p-map';
import { KueryNode, nodeBuilder } from '@kbn/es-query';
import { SavedObjectsBulkUpdateObject, SavedObjectsFindResult } from '@kbn/core/server';
import { withSpan } from '@kbn/apm-utils';
import { Logger } from '@kbn/core/server';
import { TaskManagerStartContract, TaskStatus } from '@kbn/task-manager-plugin/server';
import { RawRule, IntervalSchedule } from '../../types';
import { convertRuleIdsToKueryNode } from '../../lib';
import { ruleAuditEvent, RuleAuditAction } from '../common/audit_events';
import {
  retryIfBulkOperationConflicts,
  buildKueryNodeFilter,
  getAndValidateCommonBulkOptions,
} from '../common';
import { getRuleCircuitBreakerErrorMessage } from '../../../common';
import {
  getAuthorizationFilter,
  checkAuthorizationAndGetTotal,
  getAlertFromRaw,
  scheduleTask,
  updateMeta,
  createNewAPIKeySet,
  migrateLegacyActions,
} from '../lib';
import { RulesClientContext, BulkOperationError, BulkOptions } from '../types';
import { validateScheduleLimit } from '../../application/rule/methods/get_schedule_frequency';
import { RuleAttributes } from '../../data/rule/types';
import { RULE_SAVED_OBJECT_TYPE } from '../../saved_objects';

const getShouldScheduleTask = async (
  context: RulesClientContext,
  scheduledTaskId: string | null | undefined
) => {
  if (!scheduledTaskId) return true;
  try {
    // make sure scheduledTaskId exist
    return await withSpan({ name: 'getShouldScheduleTask', type: 'rules' }, async () => {
      const task = await context.taskManager.get(scheduledTaskId);

      // Check whether task status is unrecognized. If so, we want to delete
      // this task and create a fresh one
      if (task.status === TaskStatus.Unrecognized) {
        await context.taskManager.removeIfExists(scheduledTaskId);
        return true;
      }

      return false;
    });
  } catch (err) {
    return true;
  }
};

export const bulkEnableRules = async (context: RulesClientContext, options: BulkOptions) => {
  const { ids, filter } = getAndValidateCommonBulkOptions(options);

  const kueryNodeFilter = ids ? convertRuleIdsToKueryNode(ids) : buildKueryNodeFilter(filter);
  const authorizationFilter = await getAuthorizationFilter(context, { action: 'ENABLE' });

  const kueryNodeFilterWithAuth =
    authorizationFilter && kueryNodeFilter
      ? nodeBuilder.and([kueryNodeFilter, authorizationFilter as KueryNode])
      : kueryNodeFilter;

  const { total } = await checkAuthorizationAndGetTotal(context, {
    filter: kueryNodeFilterWithAuth,
    action: 'ENABLE',
  });

  const { errors, rules, accListSpecificForBulkOperation } = await retryIfBulkOperationConflicts({
    action: 'ENABLE',
    logger: context.logger,
    bulkOperation: (filterKueryNode: KueryNode | null) =>
      bulkEnableRulesWithOCC(context, { filter: filterKueryNode }),
    filter: kueryNodeFilterWithAuth,
  });

  const [taskIdsToEnable] = accListSpecificForBulkOperation;

  const taskIdsFailedToBeEnabled = await tryToEnableTasks({
    taskIdsToEnable,
    logger: context.logger,
    taskManager: context.taskManager,
  });

  const updatedRules = rules.map(({ id, attributes, references }) => {
    return getAlertFromRaw(
      context,
      id,
      attributes.alertTypeId as string,
      attributes as RawRule,
      references,
      false
    );
  });

  return { errors, rules: updatedRules, total, taskIdsFailedToBeEnabled };
};

const bulkEnableRulesWithOCC = async (
  context: RulesClientContext,
  { filter }: { filter: KueryNode | null }
) => {
  const additionalFilter = nodeBuilder.is('alert.attributes.enabled', 'false');

  const rulesFinder = await withSpan(
    {
      name: 'encryptedSavedObjectsClient.createPointInTimeFinderDecryptedAsInternalUser',
      type: 'rules',
    },
    async () =>
      await context.encryptedSavedObjectsClient.createPointInTimeFinderDecryptedAsInternalUser<RawRule>(
        {
          filter: filter ? nodeBuilder.and([filter, additionalFilter]) : additionalFilter,
          type: RULE_SAVED_OBJECT_TYPE,
          perPage: 100,
          ...(context.namespace ? { namespaces: [context.namespace] } : undefined),
        }
      )
  );

  const rulesFinderRules: Array<SavedObjectsFindResult<RawRule>> = [];
  const rulesToEnable: Array<SavedObjectsBulkUpdateObject<RawRule>> = [];
  const errors: BulkOperationError[] = [];
  const ruleNameToRuleIdMapping: Record<string, string> = {};
  const username = await context.getUserName();
  let scheduleValidationError = '';

  await withSpan(
    { name: 'Get rules, collect them and their attributes', type: 'rules' },
    async () => {
      for await (const response of rulesFinder.find()) {
        rulesFinderRules.push(...response.saved_objects);
      }
      await rulesFinder.close();

      const updatedInterval = rulesFinderRules
        .filter((rule) => !rule.attributes.enabled)
        .map((rule) => rule.attributes.schedule?.interval);

      const validationPayload = await validateScheduleLimit({
        context,
        updatedInterval,
      });

      if (validationPayload) {
        scheduleValidationError = getRuleCircuitBreakerErrorMessage({
          interval: validationPayload.interval,
          intervalAvailable: validationPayload.intervalAvailable,
          action: 'bulkEnable',
          rules: updatedInterval.length,
        });
      }

      await pMap(rulesFinderRules, async (rule) => {
        try {
          if (scheduleValidationError) {
            throw Error(scheduleValidationError);
          }
          if (rule.attributes.actions.length) {
            try {
              await context.actionsAuthorization.ensureAuthorized({ operation: 'execute' });
            } catch (error) {
              throw Error(`Rule not authorized for bulk enable - ${error.message}`);
            }
          }
          if (rule.attributes.name) {
            ruleNameToRuleIdMapping[rule.id] = rule.attributes.name;
          }

          const migratedActions = await migrateLegacyActions(context, {
            ruleId: rule.id,
            actions: rule.attributes.actions,
            references: rule.references,
            attributes: rule.attributes,
          });

          const updatedAttributes = updateMeta(context, {
            ...rule.attributes,
            ...(!rule.attributes.apiKey &&
              (await createNewAPIKeySet(context, {
                id: rule.attributes.alertTypeId,
                ruleName: rule.attributes.name,
                username,
                shouldUpdateApiKey: true,
              }))),
            ...(migratedActions.hasLegacyActions
              ? {
                  actions: migratedActions.resultedActions,
                  throttle: undefined,
                  notifyWhen: undefined,
                }
              : {}),
            enabled: true,
            updatedBy: username,
            updatedAt: new Date().toISOString(),
            executionStatus: {
              status: 'pending',
              lastDuration: 0,
              lastExecutionDate: new Date().toISOString(),
              error: null,
              warning: null,
            },
          });

          const shouldScheduleTask = await getShouldScheduleTask(
            context,
            rule.attributes.scheduledTaskId
          );

          let scheduledTaskId;
          if (shouldScheduleTask) {
            const scheduledTask = await scheduleTask(context, {
              id: rule.id,
              consumer: rule.attributes.consumer,
              ruleTypeId: rule.attributes.alertTypeId,
              schedule: rule.attributes.schedule as IntervalSchedule,
              throwOnConflict: false,
            });
            scheduledTaskId = scheduledTask.id;
          }

          rulesToEnable.push({
            ...rule,
            attributes: {
              ...updatedAttributes,
              ...(scheduledTaskId ? { scheduledTaskId } : undefined),
            },
            ...(migratedActions.hasLegacyActions
              ? { references: migratedActions.resultedReferences }
              : {}),
          });

          context.auditLogger?.log(
            ruleAuditEvent({
              action: RuleAuditAction.ENABLE,
              outcome: 'unknown',
              savedObject: { type: RULE_SAVED_OBJECT_TYPE, id: rule.id },
            })
          );
        } catch (error) {
          errors.push({
            message: error.message,
            rule: {
              id: rule.id,
              name: rule.attributes?.name,
            },
          });
          context.auditLogger?.log(
            ruleAuditEvent({
              action: RuleAuditAction.ENABLE,
              error,
            })
          );
        }
      });
    }
  );

  const result = await withSpan(
    { name: 'unsecuredSavedObjectsClient.bulkCreate', type: 'rules' },
    () =>
      context.unsecuredSavedObjectsClient.bulkCreate(rulesToEnable, {
        overwrite: true,
      })
  );

  const rules: Array<SavedObjectsBulkUpdateObject<RawRule>> = [];
  const taskIdsToEnable: string[] = [];

  result.saved_objects.forEach((rule) => {
    if (rule.error === undefined) {
      if (rule.attributes.scheduledTaskId) {
        taskIdsToEnable.push(rule.attributes.scheduledTaskId);
      }
      rules.push(rule);
    } else {
      errors.push({
        message: rule.error.message ?? 'n/a',
        status: rule.error.statusCode,
        rule: {
          id: rule.id,
          name: ruleNameToRuleIdMapping[rule.id] ?? 'n/a',
        },
      });
    }
  });
  return {
    errors,
    // TODO: delete the casting when we do versioning of bulk disable api
    rules: rules as Array<SavedObjectsBulkUpdateObject<RuleAttributes>>,
    accListSpecificForBulkOperation: [taskIdsToEnable],
  };
};

export const tryToEnableTasks = async ({
  taskIdsToEnable,
  logger,
  taskManager,
}: {
  taskIdsToEnable: string[];
  logger: Logger;
  taskManager: TaskManagerStartContract;
}) => {
  const taskIdsFailedToBeEnabled: string[] = [];

  if (taskIdsToEnable.length > 0) {
    try {
      const resultFromEnablingTasks = await withSpan(
        { name: 'taskManager.bulkEnable', type: 'rules' },
        async () => taskManager.bulkEnable(taskIdsToEnable)
      );
      resultFromEnablingTasks?.errors?.forEach((error) => {
        taskIdsFailedToBeEnabled.push(error.id);
      });
      if (resultFromEnablingTasks.tasks.length) {
        logger.debug(
          `Successfully enabled schedules for underlying tasks: ${resultFromEnablingTasks.tasks
            .map((task) => task.id)
            .join(', ')}`
        );
      }
      if (resultFromEnablingTasks.errors.length) {
        logger.error(
          `Failure to enable schedules for underlying tasks: ${resultFromEnablingTasks.errors
            .map((error) => error.id)
            .join(', ')}`
        );
      }
    } catch (error) {
      taskIdsFailedToBeEnabled.push(...taskIdsToEnable);
      logger.error(
        `Failure to enable schedules for underlying tasks: ${taskIdsToEnable.join(
          ', '
        )}. TaskManager bulkEnable failed with Error: ${error.message}`
      );
    }
  }
  return taskIdsFailedToBeEnabled;
};
