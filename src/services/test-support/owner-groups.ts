import type { PGlite } from '@electric-sql/pglite';

/** Z10 tests: an owner who already has both groups — owner messages go there, not to the private chat. */
export const OWNER_GROUPS = { needsAnswer: '120363000000001@g.us', reports: '120363000000002@g.us' } as const;
export async function seedOwnerGroups(pg: PGlite, tenantId: string, ownerChat: string): Promise<void> {
  await pg.query("insert into owner_channels(tenant_id,topic,chat_id,owner_chat) values($1,'needs_answer',$2,$4),($1,'reports',$3,$4)", [tenantId, OWNER_GROUPS.needsAnswer, OWNER_GROUPS.reports, ownerChat]);
}
/** The owner's chats: the private one (command replies) and both groups. */
export const isOwnerChat = (owner: string) => (chatId: string) => chatId === owner || chatId === OWNER_GROUPS.needsAnswer || chatId === OWNER_GROUPS.reports;
