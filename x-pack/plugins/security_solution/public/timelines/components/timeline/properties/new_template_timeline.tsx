/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';

import { TimelineId } from '../../../../../common/types/timeline';
import { TimelineType } from '../../../../../common/api/timeline';

import { useCreateTimelineButton } from './use_create_timeline';

interface OwnProps {
  onClick?: () => void;
  outline?: boolean;
  title?: string;
  timelineId?: string;
}

export const NewTemplateTimelineComponent: React.FC<OwnProps> = ({
  onClick,
  outline,
  title,
  timelineId = TimelineId.active,
}) => {
  const { getButton } = useCreateTimelineButton({
    timelineId,
    timelineType: TimelineType.template,
    onClick,
  });

  const button = getButton({ outline, title });

  return button;
};

export const NewTemplateTimeline = React.memo(NewTemplateTimelineComponent);
NewTemplateTimeline.displayName = 'NewTemplateTimeline';
