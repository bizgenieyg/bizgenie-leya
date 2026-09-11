import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const migration=readFileSync('supabase/migrations/20260911181238_042_assistant_tone_values.sql','utf8');
const tones=['friendly_professional','warm_conversational','concise_direct','formal_respectful'];

test('042 normalizes legacy tone values and closes assistant_profiles tone',()=>{
  assert.match(migration,/update public\.assistant_profiles/);
  assert.match(migration,/alter column tone set not null/);
  assert.match(migration,/assistant_profiles_tone_check/);
  for(const tone of tones)assert.match(migration,new RegExp(`'${tone}'`));
});
