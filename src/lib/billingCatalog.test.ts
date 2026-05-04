import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canUsePaidAI,
  creditCostForAction,
  creditsForPlan,
  parseCheckoutPlan,
} from './billing';

test('billing catalog parses the chat monthly plan', () => {
  assert.deepEqual(parseCheckoutPlan('chat_monthly'), {
    id: 'chat_monthly',
    price: 10,
    name: 'AI Chat + Resume Agent',
  });

  assert.equal(parseCheckoutPlan('pro_monthly'), null);
  assert.equal(parseCheckoutPlan('pro_plus_monthly'), null);
  assert.equal(parseCheckoutPlan('pro_plus'), null);
  assert.equal(parseCheckoutPlan('pro_100_monthly'), null);
  assert.equal(parseCheckoutPlan('business_10000_monthly'), null);
});

test('AI actions use simple integer action costs', () => {
  assert.equal(creditCostForAction('resume_edit'), 1);
  assert.equal(creditCostForAction('tailor_resume'), 1);
  assert.equal(creditCostForAction('resume_optimizer'), 1);
  assert.equal(creditCostForAction('cover_letter'), 1);
  assert.equal(creditCostForAction('resume_builder'), 2);
  assert.equal(creditCostForAction('ai_chat_reply'), 1);
});

test('chat monthly subscriptions are access-based, not action-based', () => {
  assert.equal(creditsForPlan('chat_monthly'), 0);
});

test('AI access requires an active paid subscription', () => {
  assert.equal(canUsePaidAI('chat_monthly', 'active'), true);
  assert.equal(canUsePaidAI('chat_monthly', 'trialing'), true);
  assert.equal(canUsePaidAI('chat_monthly', 'canceled'), false);
  assert.equal(canUsePaidAI('unpaid', 'unpaid'), false);
  assert.equal(canUsePaidAI(null, null), false);
});
