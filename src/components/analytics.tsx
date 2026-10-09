'use client';

import { Analytics as VercelAnalytics } from '@vercel/analytics/next';
import { stripQuery } from '@/lib/analytics';

export function Analytics() {
  return <VercelAnalytics beforeSend={stripQuery} />;
}
