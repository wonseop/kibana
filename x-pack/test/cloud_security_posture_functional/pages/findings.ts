/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import expect from '@kbn/expect';
import Chance from 'chance';
import type { FtrProviderContext } from '../ftr_provider_context';

// eslint-disable-next-line import/no-default-export
export default function ({ getPageObjects, getService }: FtrProviderContext) {
  const queryBar = getService('queryBar');
  const filterBar = getService('filterBar');
  const testSubjects = getService('testSubjects');
  const retry = getService('retry');
  const pageObjects = getPageObjects(['common', 'findings', 'header']);
  const chance = new Chance();
  const timeFiveHoursAgo = (Date.now() - 18000000).toString();

  // We need to use a dataset for the tests to run
  // We intentionally make some fields start with a capital letter to test that the query bar is case-insensitive/case-sensitive
  const data = [
    {
      '@timestamp': timeFiveHoursAgo,
      resource: { id: chance.guid(), name: `kubelet`, sub_type: 'lower case sub type' },
      result: { evaluation: chance.integer() % 2 === 0 ? 'passed' : 'failed' },
      rule: {
        name: 'Upper case rule name',
        section: 'Upper case section',
        benchmark: {
          id: 'cis_k8s',
          posture_type: 'kspm',
          name: 'CIS Kubernetes V1.23',
          version: 'v1.0.0',
        },
        type: 'process',
      },
      cluster_id: 'Upper case cluster id',
    },
    {
      '@timestamp': timeFiveHoursAgo,
      resource: { id: chance.guid(), name: `Pod`, sub_type: 'Upper case sub type' },
      result: { evaluation: chance.integer() % 2 === 0 ? 'passed' : 'failed' },
      rule: {
        name: 'lower case rule name',
        section: 'Another upper case section',
        benchmark: {
          id: 'cis_k8s',
          posture_type: 'kspm',
          name: 'CIS Kubernetes V1.23',
          version: 'v1.0.0',
        },
        type: 'process',
      },
      cluster_id: 'Another Upper case cluster id',
    },
    {
      '@timestamp': timeFiveHoursAgo,
      resource: { id: chance.guid(), name: `process`, sub_type: 'another lower case type' },
      result: { evaluation: 'passed' },
      rule: {
        name: 'Another upper case rule name',
        section: 'lower case section',
        benchmark: {
          id: 'cis_k8s',
          posture_type: 'kspm',
          name: 'CIS Kubernetes V1.23',
          version: 'v1.0.0',
        },
        type: 'process',
      },
      cluster_id: 'lower case cluster id',
    },
    {
      '@timestamp': timeFiveHoursAgo,
      resource: { id: chance.guid(), name: `process`, sub_type: 'Upper case type again' },
      result: { evaluation: 'failed' },
      rule: {
        name: 'some lower case rule name',
        section: 'another lower case section',
        benchmark: {
          id: 'cis_k8s',
          posture_type: 'kspm',
          name: 'CIS Kubernetes V1.23',
          version: 'v1.0.0',
        },
        type: 'process',
      },
      cluster_id: 'another lower case cluster id',
    },
  ];

  const ruleName1 = data[0].rule.name;
  const ruleName2 = data[1].rule.name;

  describe('Findings Page', function () {
    this.tags(['cloud_security_posture_findings']);
    let findings: typeof pageObjects.findings;
    let latestFindingsTable: typeof findings.latestFindingsTable;
    let distributionBar: typeof findings.distributionBar;

    before(async () => {
      findings = pageObjects.findings;
      latestFindingsTable = findings.latestFindingsTable;
      distributionBar = findings.distributionBar;

      // Before we start any test we must wait for cloud_security_posture plugin to complete its initialization
      await findings.waitForPluginInitialized();

      // Prepare mocked findings
      await findings.index.remove();
      await findings.index.add(data);

      await findings.navigateToLatestFindingsPage();
      await retry.waitFor(
        'Findings table to be loaded',
        async () => (await latestFindingsTable.getRowsCount()) === data.length
      );
      pageObjects.header.waitUntilLoadingHasFinished();
    });

    after(async () => {
      await findings.index.remove();
    });

    describe('SearchBar', () => {
      it('add filter', async () => {
        // Filter bar uses the field's customLabel in the DataView
        await filterBar.addFilter({ field: 'Rule Name', operation: 'is', value: ruleName1 });

        expect(await filterBar.hasFilter('rule.name', ruleName1)).to.be(true);
        expect(await latestFindingsTable.hasColumnValue('rule.name', ruleName1)).to.be(true);
      });

      it('remove filter', async () => {
        await filterBar.removeFilter('rule.name');

        expect(await filterBar.hasFilter('rule.name', ruleName1)).to.be(false);
        expect(await latestFindingsTable.getRowsCount()).to.be(data.length);
      });

      it('set search query', async () => {
        await queryBar.setQuery(ruleName1);
        await queryBar.submitQuery();

        expect(await latestFindingsTable.hasColumnValue('rule.name', ruleName1)).to.be(true);
        expect(await latestFindingsTable.hasColumnValue('rule.name', ruleName2)).to.be(false);

        await queryBar.setQuery('');
        await queryBar.submitQuery();

        expect(await latestFindingsTable.getRowsCount()).to.be(data.length);
      });
    });

    // FLAKY: https://github.com/elastic/kibana/issues/152913
    describe.skip('Table Sort', () => {
      type SortingMethod = (a: string, b: string) => number;
      type SortDirection = 'asc' | 'desc';
      // Sort by lexical order will sort by the first character of the string (case-sensitive)
      const compareStringByLexicographicOrder = (a: string, b: string) => {
        return a > b ? 1 : b > a ? -1 : 0;
      };
      const sortByAlphabeticalOrder = (a: string, b: string) => {
        return a.localeCompare(b);
      };

      it('sorts by a column, should be case sensitive/insensitive depending on the column', async () => {
        type TestCase = [string, SortDirection, SortingMethod];
        const testCases: TestCase[] = [
          ['rule.section', 'asc', sortByAlphabeticalOrder],
          ['rule.section', 'desc', sortByAlphabeticalOrder],
          ['resource.id', 'asc', compareStringByLexicographicOrder],
          ['resource.id', 'desc', compareStringByLexicographicOrder],
          ['resource.name', 'asc', sortByAlphabeticalOrder],
          ['resource.name', 'desc', sortByAlphabeticalOrder],
          ['resource.sub_type', 'asc', sortByAlphabeticalOrder],
          ['resource.sub_type', 'desc', sortByAlphabeticalOrder],
        ];
        for (const [columnName, dir, sortingMethod] of testCases) {
          await latestFindingsTable.toggleColumnSort(columnName, dir);
          /* This sleep or delay is added to allow some time for the column to settle down before we get the value and to prevent the test from getting the wrong value*/
          pageObjects.header.waitUntilLoadingHasFinished();
          const values = (await latestFindingsTable.getColumnValues(columnName)).filter(Boolean);
          expect(values).to.not.be.empty();
          const sorted = values
            .slice()
            .sort((a, b) => (dir === 'asc' ? sortingMethod(a, b) : sortingMethod(b, a)));
          values.forEach((value, i) => {
            expect(value).to.be.eql(
              sorted[i],
              `Row number ${i + 1} missmatch, expected value: ${value}. Instead got: ${sorted[i]}`
            );
          });
        }
      });
    });

    describe('DistributionBar', () => {
      (['passed', 'failed'] as const).forEach((type) => {
        it(`filters by ${type} findings`, async () => {
          await distributionBar.filterBy(type);

          const items = data.filter(({ result }) => result.evaluation === type);
          expect(await latestFindingsTable.getFindingsCount(type)).to.eql(items.length);

          await filterBar.removeFilter('result.evaluation');
        });
      });
    });

    describe('Findings - Fields selector', () => {
      const CSP_FIELDS_SELECTOR_MODAL = 'cloudSecurityFieldsSelectorModal';
      const CSP_FIELDS_SELECTOR_OPEN_BUTTON = 'cloudSecurityFieldsSelectorOpenButton';
      const CSP_FIELDS_SELECTOR_RESET_BUTTON = 'cloudSecurityFieldsSelectorResetButton';
      const CSP_FIELDS_SELECTOR_CLOSE_BUTTON = 'cloudSecurityFieldsSelectorCloseButton';

      it('Add fields to the Findings DataTable', async () => {
        const fieldsButton = await testSubjects.find(CSP_FIELDS_SELECTOR_OPEN_BUTTON);
        await fieldsButton.click();
        await testSubjects.existOrFail(CSP_FIELDS_SELECTOR_MODAL);

        const agentIdCheckbox = await testSubjects.find(
          'cloud-security-fields-selector-item-agent.id'
        );
        await agentIdCheckbox.click();

        const agentNameCheckbox = await testSubjects.find(
          'cloud-security-fields-selector-item-agent.name'
        );
        await agentNameCheckbox.click();

        await testSubjects.existOrFail('dataGridHeaderCell-agent.id');
        await testSubjects.existOrFail('dataGridHeaderCell-agent.name');

        const closeFieldsButton = await testSubjects.find(CSP_FIELDS_SELECTOR_CLOSE_BUTTON);
        await closeFieldsButton.click();
        await testSubjects.missingOrFail(CSP_FIELDS_SELECTOR_MODAL);
      });

      it('Remove fields from the Findings DataTable', async () => {
        const fieldsButton = await testSubjects.find(CSP_FIELDS_SELECTOR_OPEN_BUTTON);
        await fieldsButton.click();

        const agentIdCheckbox = await testSubjects.find(
          'cloud-security-fields-selector-item-agent.id'
        );
        await agentIdCheckbox.click();

        const agentNameCheckbox = await testSubjects.find(
          'cloud-security-fields-selector-item-agent.name'
        );
        await agentNameCheckbox.click();

        await testSubjects.missingOrFail('dataGridHeaderCell-agent.id');
        await testSubjects.missingOrFail('dataGridHeaderCell-agent.name');

        const closeFieldsButton = await testSubjects.find(CSP_FIELDS_SELECTOR_CLOSE_BUTTON);
        await closeFieldsButton.click();
        await testSubjects.missingOrFail(CSP_FIELDS_SELECTOR_MODAL);
      });
      it('Reset fields to default', async () => {
        const fieldsButton = await testSubjects.find(CSP_FIELDS_SELECTOR_OPEN_BUTTON);
        await fieldsButton.click();

        const agentIdCheckbox = await testSubjects.find(
          'cloud-security-fields-selector-item-agent.id'
        );
        await agentIdCheckbox.click();

        const agentNameCheckbox = await testSubjects.find(
          'cloud-security-fields-selector-item-agent.name'
        );
        await agentNameCheckbox.click();

        await testSubjects.existOrFail('dataGridHeaderCell-agent.id');
        await testSubjects.existOrFail('dataGridHeaderCell-agent.name');

        const resetFieldsButton = await testSubjects.find(CSP_FIELDS_SELECTOR_RESET_BUTTON);
        await resetFieldsButton.click();

        await testSubjects.missingOrFail('dataGridHeaderCell-agent.id');
        await testSubjects.missingOrFail('dataGridHeaderCell-agent.name');

        const closeFieldsButton = await testSubjects.find(CSP_FIELDS_SELECTOR_CLOSE_BUTTON);
        await closeFieldsButton.click();
        await testSubjects.missingOrFail(CSP_FIELDS_SELECTOR_MODAL);
      });
    });
  });
}
