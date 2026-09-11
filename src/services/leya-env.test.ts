import assert from 'node:assert/strict';
import test from 'node:test';
import {readLeyaEnvironment} from '../config/leya-env.js';

test('Leya environment accepts current names, legacy fallback and current priority',()=>{
  const warnings:string[]=[];
  assert.deepEqual(readLeyaEnvironment({LEYA_API_URL:'https://new.example',LEYA_ADMIN_API_KEY:'new-key'},message=>warnings.push(message)),{apiUrl:'https://new.example',adminApiKey:'new-key'});
  assert.deepEqual(readLeyaEnvironment({LEIA_API_URL:'https://old.example',LEIA_ADMIN_API_KEY:'old-key'},message=>warnings.push(message)),{apiUrl:'https://old.example',adminApiKey:'old-key'});
  assert.deepEqual(readLeyaEnvironment({LEYA_API_URL:'https://new.example',LEIA_API_URL:'https://old.example',LEYA_ADMIN_API_KEY:'new-key',LEIA_ADMIN_API_KEY:'old-key'},message=>warnings.push(message)),{apiUrl:'https://new.example',adminApiKey:'new-key'});
  assert.equal(warnings.length,2);
  assert.match(warnings[0] ?? '',/LEIA_API_URL/);
  assert.match(warnings[1] ?? '',/LEIA_ADMIN_API_KEY/);
});
