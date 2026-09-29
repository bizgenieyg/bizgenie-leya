/**
 * Words that make a promise or an evaluation (task W). A fact may contain one only if its quote has it:
 * "бесплатный пробный период" from the quote "Да, две недели" is a claim the owner never made.
 * Stems, matched at a word start, case-insensitive. Edited here, no migration.
 */
export const CLAIM_STEMS: readonly string[] = [
  'бесплатн', 'даром', 'гарант', 'скидк', 'акци', 'всегда', 'никогда', 'любой момент', 'любое время', 'в любой', 'давно', 'лучш', 'самый', 'самая', 'самое',
  'мгновенн', 'моментальн', 'без ограничен', 'безлимит', 'навсегда', 'бессрочн', 'бесплатно', 'подарок', 'возврат', 'возвращ', '100%', '100 %',
  'free', 'guarante', 'discount', 'always', 'never', 'anytime', 'any time', 'best', 'instant', 'unlimited', 'forever', 'refund', 'long ago', 'for years',
  'חינם', 'בחינם', 'אחריות', 'הנחה', 'תמיד', 'אף פעם', 'בכל עת', 'בכל רגע', 'הכי טוב', 'מיידי', 'ללא הגבלה', 'החזר',
];
/** Words shorter than this, and these, are not "concrete details" of a block (duplicate check). */
export const DETAIL_MIN_LENGTH = 4;
export const DETAIL_STOP_WORDS: readonly string[] = [
  'это', 'этот', 'если', 'когда', 'чтобы', 'который', 'которые', 'можно', 'нужно', 'есть', 'будет', 'ваша', 'ваше', 'ваши', 'вашего', 'вашей', 'вам', 'вас', 'наш', 'наша',
  'также', 'только', 'очень', 'сейчас', 'после', 'перед', 'через', 'между', 'всё', 'все', 'всех', 'для', 'при', 'как', 'что', 'где', 'или', 'так', 'уже',
  'that', 'this', 'with', 'your', 'from', 'have', 'will', 'what', 'when', 'which',
];
/** Share of a block's concrete words that the named fact must contain for a "duplicate" skip. */
export const DUPLICATE_DETAIL_SHARE = 0.8;
