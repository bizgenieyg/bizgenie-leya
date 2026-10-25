/**
 * Z10: the owner's group topics. A module adds its own topic here (with `owner.channel_<topic>` and
 * `owner.channel_<topic>_description` templates) without changing the existing ones.
 *   needs_answer — client questions, requests, follow-ups (answered with a quoted reply);
 *   reports      — summaries and service notices.
 */
export const OWNER_TOPICS = ['needs_answer', 'reports'] as const;
export type OwnerTopic = (typeof OWNER_TOPICS)[number];
