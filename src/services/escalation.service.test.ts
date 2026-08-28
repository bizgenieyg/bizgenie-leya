import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEscalationText,
  isWithinQuietHours,
  nextQuietHoursEnd,
} from "./escalation.service.js";

const muteAll = (start: string | null, end: string | null) => ({
  mode: "mute_all",
  quiet_hours_start: start,
  quiet_hours_end: end,
});

const at = (hours: number, minutes = 0) => {
  const date = new Date(2026, 7, 28, hours, minutes, 0, 0);
  return date;
};

test("quiet hours: same-day window includes times inside it", () => {
  assert.equal(isWithinQuietHours(muteAll("13:00", "15:00"), at(14)), true);
  assert.equal(isWithinQuietHours(muteAll("13:00", "15:00"), at(15)), false);
  assert.equal(isWithinQuietHours(muteAll("13:00", "15:00"), at(12, 59)), false);
});

test("quiet hours: window wrapping past midnight", () => {
  const night = muteAll("22:00", "08:00");
  assert.equal(isWithinQuietHours(night, at(23)), true);
  assert.equal(isWithinQuietHours(night, at(3)), true);
  assert.equal(isWithinQuietHours(night, at(8)), false);
  assert.equal(isWithinQuietHours(night, at(12)), false);
});

test("quiet hours: only mute_all mode is honoured", () => {
  const settings = { ...muteAll("22:00", "08:00"), mode: "whitelist" };
  assert.equal(isWithinQuietHours(settings, at(23)), false);
});

test("quiet hours: no window configured means never muted", () => {
  assert.equal(isWithinQuietHours(muteAll(null, null), at(3)), false);
});

test("nextQuietHoursEnd rolls to tomorrow when end already passed today", () => {
  const night = muteAll("22:00", "08:00");
  const deferred = nextQuietHoursEnd(night, at(23));
  assert.equal(deferred.getHours(), 8);
  assert.equal(deferred.getDate(), 29);
});

test("nextQuietHoursEnd stays today when end is still ahead", () => {
  const night = muteAll("22:00", "08:00");
  const deferred = nextQuietHoursEnd(night, at(3));
  assert.equal(deferred.getHours(), 8);
  assert.equal(deferred.getDate(), 28);
});

test("escalation text keeps the owner template", () => {
  const body = buildEscalationText("Dana", "Do you open on Saturday?");
  assert.match(body, /❓ Новый вопрос от Dana:/);
  assert.match(body, /Do you open on Saturday\?/);
  assert.match(body, /Лея не нашла ответ в базе знаний\./);
});
