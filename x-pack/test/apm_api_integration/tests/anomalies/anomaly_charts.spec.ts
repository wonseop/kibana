/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ApmMlDetectorType } from '@kbn/apm-plugin/common/anomaly_detection/apm_ml_detectors';
import { ServiceAnomalyTimeseries } from '@kbn/apm-plugin/common/anomaly_detection/service_anomaly_timeseries';
import { Environment } from '@kbn/apm-plugin/common/environment_rt';
import { apm, timerange } from '@kbn/apm-synthtrace-client';
import expect from '@kbn/expect';
import { last, omit, range } from 'lodash';
import moment from 'moment';
import { ApmApiError } from '../../common/apm_api_supertest';
import { FtrProviderContext } from '../../common/ftr_provider_context';
import { createAndRunApmMlJobs } from '../../common/utils/create_and_run_apm_ml_jobs';

export default function ApiTest({ getService }: FtrProviderContext) {
  const registry = getService('registry');
  const apmApiClient = getService('apmApiClient');
  const ml = getService('ml');
  const es = getService('es');
  const logger = getService('log');
  const synthtraceEsClient = getService('synthtraceEsClient');

  const start = moment().subtract(2, 'days');
  const end = moment();
  const spikeStart = moment().subtract(8, 'hours');
  const spikeEnd = moment().subtract(6, 'hours');

  async function statusOf(p: Promise<{ status: number }>) {
    try {
      const { status } = await p;
      return status;
    } catch (err) {
      if (err instanceof ApmApiError) {
        return err.res.status;
      }
      throw err;
    }
  }

  function getAnomalyCharts(
    {
      transactionType,
      serviceName,
      environment,
    }: {
      transactionType: string;
      serviceName: string;
      environment: Environment;
    },
    user = apmApiClient.readUser
  ) {
    return user({
      endpoint: 'GET /internal/apm/services/{serviceName}/anomaly_charts',
      params: {
        path: {
          serviceName,
        },
        query: {
          start: start.toISOString(),
          end: end.toISOString(),
          transactionType,
          environment,
        },
      },
    });
  }

  registry.when(
    'fetching service anomalies with a basic license',
    { config: 'basic', archives: [] },
    () => {
      it('returns a 501', async () => {
        const status = await statusOf(
          getAnomalyCharts({
            serviceName: 'a',
            transactionType: 'request',
            environment: 'ENVIRONMENT_ALL',
          })
        );

        expect(status).to.eql(501);
      });
    }
  );

  registry.when(
    'fetching service anomalies with a trial license',
    { config: 'trial', archives: [] },
    () => {
      const NORMAL_DURATION = 100;
      const NORMAL_RATE = 1;

      beforeEach(async () => {
        const serviceA = apm
          .service({ name: 'a', environment: 'production', agentName: 'java' })
          .instance('a');

        const serviceB = apm
          .service({ name: 'b', environment: 'development', agentName: 'go' })
          .instance('b');

        const events = timerange(start.valueOf(), end.valueOf())
          .interval('1m')
          .rate(1)
          .generator((timestamp) => {
            const isInSpike = timestamp >= spikeStart.valueOf() && timestamp < spikeEnd.valueOf();
            const count = isInSpike ? 4 : NORMAL_RATE;
            const duration = isInSpike ? 10000 : NORMAL_DURATION;
            const outcome = isInSpike ? 'failure' : 'success';

            return [
              ...range(0, count).flatMap((_) =>
                serviceA
                  .transaction({ transactionName: 'tx', transactionType: 'request' })
                  .timestamp(timestamp)
                  .duration(duration)
                  .outcome(outcome)
              ),
              serviceB
                .transaction({ transactionName: 'tx', transactionType: 'Worker' })
                .timestamp(timestamp)
                .duration(duration)
                .success(),
            ];
          });

        await synthtraceEsClient.index(events);
      });

      afterEach(async () => {
        await cleanup();
      });

      async function cleanup() {
        await synthtraceEsClient.clean();
        await ml.cleanMlIndices();
      }

      it('returns a 403 for a user without access to ML', async () => {
        expect(
          await statusOf(
            getAnomalyCharts(
              {
                serviceName: 'a',
                transactionType: 'request',
                environment: 'ENVIRONMENT_ALL',
              },
              apmApiClient.noMlAccessUser
            )
          )
        ).to.eql(403);
      });

      describe('without ml jobs', () => {
        it('returns a 200 for a user _with_ access to ML', async () => {
          const status = await statusOf(
            getAnomalyCharts({
              serviceName: 'a',
              transactionType: 'request',
              environment: 'ENVIRONMENT_ALL',
            })
          );

          expect(status).to.eql(200);
        });
      });

      describe('with ml jobs', () => {
        beforeEach(async () => {
          await createAndRunApmMlJobs({
            es,
            ml,
            environments: ['production', 'development'],
            logger,
          });
        });

        it('returns a 200 for a user _with_ access to ML', async () => {
          const status = await statusOf(
            getAnomalyCharts({
              serviceName: 'a',
              transactionType: 'request',
              environment: 'ENVIRONMENT_ALL',
            })
          );

          expect(status).to.eql(200);
        });

        describe('inspecting the body', () => {
          let allAnomalyTimeseries: ServiceAnomalyTimeseries[];

          let latencySeries: ServiceAnomalyTimeseries | undefined;
          let throughputSeries: ServiceAnomalyTimeseries | undefined;
          let failureRateSeries: ServiceAnomalyTimeseries | undefined;
          const endTimeMs = end.valueOf();

          beforeEach(async () => {
            allAnomalyTimeseries = (
              await getAnomalyCharts({
                serviceName: 'a',
                transactionType: 'request',
                environment: 'ENVIRONMENT_ALL',
              })
            ).body.allAnomalyTimeseries;

            latencySeries = allAnomalyTimeseries.find(
              (spec) => spec.type === ApmMlDetectorType.txLatency
            );
            throughputSeries = allAnomalyTimeseries.find(
              (spec) => spec.type === ApmMlDetectorType.txThroughput
            );
            failureRateSeries = allAnomalyTimeseries.find(
              (spec) => spec.type === ApmMlDetectorType.txFailureRate
            );
          });

          it('returns model plots for all detectors and job ids for the given transaction type', () => {
            expect(allAnomalyTimeseries.length).to.eql(3);

            expect(
              allAnomalyTimeseries.every((spec) => spec.bounds.some((bound) => bound.y0 ?? 0 > 0))
            );
          });

          it('returns model plots with bounds for x range within start and end', () => {
            expect(allAnomalyTimeseries.length).to.eql(3);

            expect(
              allAnomalyTimeseries.every((spec) =>
                spec.bounds.every((bound) => bound.x >= start.valueOf() && bound.x <= endTimeMs)
              )
            );
          });

          it('returns model plots with latest bucket matching the end time', () => {
            expect(allAnomalyTimeseries.every((spec) => last(spec.bounds)?.x === endTimeMs));
          });

          it('returns the correct metadata', () => {
            function omitTimeseriesData(series: ServiceAnomalyTimeseries | undefined) {
              return series ? omit(series, 'anomalies', 'bounds') : undefined;
            }

            expect(omitTimeseriesData(latencySeries)).to.eql({
              type: ApmMlDetectorType.txLatency,
              jobId: 'apm-tx-metrics-production',
              serviceName: 'a',
              environment: 'production',
              transactionType: 'request',
              version: 3,
            });

            expect(omitTimeseriesData(throughputSeries)).to.eql({
              type: ApmMlDetectorType.txThroughput,
              jobId: 'apm-tx-metrics-production',
              serviceName: 'a',
              environment: 'production',
              transactionType: 'request',
              version: 3,
            });

            expect(omitTimeseriesData(failureRateSeries)).to.eql({
              type: ApmMlDetectorType.txFailureRate,
              jobId: 'apm-tx-metrics-production',
              serviceName: 'a',
              environment: 'production',
              transactionType: 'request',
              version: 3,
            });
          });

          it('returns anomalies for during the spike', () => {
            const latencyAnomalies = latencySeries?.anomalies.filter(
              (anomaly) => anomaly.y ?? 0 > 0
            );

            const throughputAnomalies = throughputSeries?.anomalies.filter(
              (anomaly) => anomaly.y ?? 0 > 0
            );

            const failureRateAnomalies = failureRateSeries?.anomalies.filter(
              (anomaly) => anomaly.y ?? 0 > 0
            );

            expect(latencyAnomalies?.length).to.be.greaterThan(0);

            expect(throughputAnomalies?.length).to.be.greaterThan(0);

            expect(failureRateAnomalies?.length).to.be.greaterThan(0);

            expect(
              latencyAnomalies?.every(
                (anomaly) =>
                  anomaly.x >= spikeStart.valueOf() && (anomaly.actual ?? 0) > NORMAL_DURATION
              )
            );

            expect(
              throughputAnomalies?.every(
                (anomaly) =>
                  anomaly.x >= spikeStart.valueOf() && (anomaly.actual ?? 0) > NORMAL_RATE
              )
            );

            expect(
              failureRateAnomalies?.every(
                (anomaly) => anomaly.x >= spikeStart.valueOf() && (anomaly.actual ?? 0) > 0
              )
            );
          });
        });
      });
    }
  );
}
