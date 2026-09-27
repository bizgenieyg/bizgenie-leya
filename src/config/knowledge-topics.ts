import { discoverySet, type DiscoverySet } from './discovery.js';

/** Topics of the business profile. A code enum (no DB check): a topic is added here without a migration. */
export const KNOWLEDGE_TOPICS = ['services_prices', 'location_hours', 'booking', 'faq', 'payment_cancel', 'why_us', 'about', 'other'] as const;
export type KnowledgeTopic = (typeof KNOWLEDGE_TOPICS)[number];
export const isKnowledgeTopic = (value: unknown): value is KnowledgeTopic => typeof value === 'string' && (KNOWLEDGE_TOPICS as readonly string[]).includes(value);

/** Topics that go to the model whole even when the profile is too large to send completely. */
export const CORE_TOPICS: readonly KnowledgeTopic[] = ['services_prices', 'location_hours', 'booking'];

/** Topics an empty profile is flagged for ("Рассказать →"), by business sector. */
export const REQUIRED_TOPICS: Record<DiscoverySet, readonly KnowledgeTopic[]> = {
  beauty: KNOWLEDGE_TOPICS.slice(0, 6),
  business: KNOWLEDGE_TOPICS.slice(0, 6),
  food: ['services_prices', 'location_hours', 'booking', 'faq', 'payment_cancel'],
  other: ['services_prices', 'location_hours', 'booking', 'faq'],
};
export const requiredTopics = (sector: string | null | undefined): readonly KnowledgeTopic[] => REQUIRED_TOPICS[discoverySet(sector)];

/** Topic names for the model prompts (the cabinet has its own translated labels). */
export const TOPIC_PROMPT_NAMES: Record<KnowledgeTopic, string> = {
  services_prices: 'услуги и цены', location_hours: 'адрес и часы работы', booking: 'как записаться или начать', faq: 'частые вопросы',
  payment_cancel: 'оплата и отмена', why_us: 'почему выбирают этот бизнес', about: 'о бизнесе', other: 'другое',
};
