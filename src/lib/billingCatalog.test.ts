import assert from 'node:assert/strict';
import test from 'node:test';
import {
  creditCostForAction,
  creditsForPlan,
  creditsForTopUp,
  freeMonthlyActionsRemaining,
  parseCheckoutPlan,
  parseTopUpPackage,
} from './billing';

test('billing catalog parses simple monthly plans', () => {
  assert.deepEqual(parseCheckoutPlan('pro_monthly'), {
    id: 'pro_monthly',
    actions: 100,
    rolloverCap: 100,
    price: 20,
    name: 'Pro',
  });

  assert.deepEqual(parseCheckoutPlan('pro_plus_monthly'), {
    id: 'pro_plus_monthly',
    actions: 400,
    rolloverCap: 400,
    price: 60,
    name: 'Pro Plus',
  });

  assert.equal(parseCheckoutPlan('pro_plus'), null);
  assert.equal(parseCheckoutPlan('pro_100_monthly'), null);
  assert.equal(parseCheckoutPlan('business_10000_monthly'), null);
});

test('billing catalog supports one paid top-up package', () => {
  assert.deepEqual(parseTopUpPackage('actions_50'), { id: 'actions_50', actions: 50, price: 15 });
  assert.equal(parseTopUpPackage('credits_50'), null);
  assert.equal(parseTopUpPackage('actions_100'), null);
});

test('AI resume actions use simple integer action costs', () => {
  assert.equal(creditCostForAction('resume_edit'), 1);
  assert.equal(creditCostForAction('tailor_resume'), 1);
  assert.equal(creditCostForAction('resume_optimizer'), 1);
  assert.equal(creditCostForAction('cover_letter'), 1);
  assert.equal(creditCostForAction('resume_builder'), 2);
});

test('action helpers return selected monthly and top-up amounts', () => {
  assert.equal(creditsForPlan('pro_monthly'), 100);
  assert.equal(creditsForPlan('pro_plus_monthly'), 400);
  assert.equal(creditsForTopUp('actions_50'), 50);
});

test('free monthly allowance stops at five actions', () => {
  assert.equal(freeMonthlyActionsRemaining(0), 5);
  assert.equal(freeMonthlyActionsRemaining(4), 1);
  assert.equal(freeMonthlyActionsRemaining(5), 0);
  assert.equal(freeMonthlyActionsRemaining(7), 0);
});
