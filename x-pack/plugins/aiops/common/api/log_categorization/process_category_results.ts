/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { get } from 'lodash';

import { estypes } from '@elastic/elasticsearch';

import { createRandomSamplerWrapper } from '@kbn/ml-random-sampler-utils';

import type { Category, CategoriesAgg, CatResponse } from './types';

export function processCategoryResults(
  result: CatResponse,
  field: string,
  unwrap: ReturnType<typeof createRandomSamplerWrapper>['unwrap']
) {
  const { aggregations } = result.rawResponse;
  if (aggregations === undefined) {
    throw new Error('processCategoryResults failed, did not return aggregations.');
  }
  const {
    categories: { buckets },
  } = unwrap(
    aggregations as unknown as Record<string, estypes.AggregationsAggregate>
  ) as CategoriesAgg;

  const categories: Category[] = buckets.map((b) => {
    const sparkline =
      b.sparkline === undefined
        ? {}
        : b.sparkline.buckets.reduce<Record<number, number>>((acc2, cur2) => {
            acc2[cur2.key] = cur2.doc_count;
            return acc2;
          }, {});

    return {
      key: b.key,
      count: b.doc_count,
      examples: b.examples.hits.hits.map((h) => get(h._source, field)),
      sparkline,
      subTimeRangeCount: b.sub_time_range?.buckets[0].doc_count ?? undefined,
      subFieldCount: b.sub_time_range?.buckets[0].sub_field?.doc_count ?? undefined,
      subFieldExamples:
        b.sub_time_range?.buckets[0].examples.hits.hits.map((h) => get(h._source, field)) ??
        undefined,
    };
  });
  return {
    categories,
  };
}
