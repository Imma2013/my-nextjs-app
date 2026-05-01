import assert from 'node:assert/strict';
import test from 'node:test';
import {
  creditCostForAction,
  creditsForPlan,
  creditsForTopUp,
  parseCheckoutPlan,
  parseTopUpPackage,
} from './billing';

test('billing catalog parses Lovable-style monthly Pro and Business plans', () => {
  assert.deepEqual(parseCheckoutPlan('pro_100_monthly'), {
    id: 'pro_100_monthly',
    family: 'pro',
    tier: 100,
    credits: 100,
    price: 25,
    name: 'Pro 100',
  });

  assert.deepEqual(parseCheckoutPlan('business_10000_monthly'), {
    id: 'business_10000_monthly',
    family: 'business',
    tier: 10000,
    credits: 10000,
    price: 4300,
    name: 'Business 10000',
  });

  assert.equal(parseCheckoutPlan('pro_plus'), null);
  assert.equal(parseCheckoutPlan('pro_75_monthly'), null);
});

test('billing catalog supports 50-credit top-up increments only', () => {
  assert.deepEqual(parseTopUpPackage('credits_50'), { id: 'credits_50', credits: 50 });
  assert.deepEqual(parseTopUpPackage('credits_1000'), { id: 'credits_1000', credits: 1000 });
  assert.equal(parseTopUpPackage('credits_20'), null);
  assert.equal(parseTopUpPackage('credits_1050'), null);
});

test('AI resume actions use decimal Lovable-style credit costs', () => {
  assert.equal(creditCostForAction('resume_edit'), 0.9);
  assert.equal(creditCostForAction('tailor_resume'), 1.2);
  assert.equal(creditCostForAction('resume_optimizer'), 1.2);
  assert.equal(creditCostForAction('cover_letter'), 1.2);
  assert.equal(creditCostForAction('resume_builder'), 2);
});

test('credit helpers return selected monthly and top-up amounts', () => {
  assert.equal(creditsForPlan('pro_400_monthly'), 400);
  assert.equal(creditsForPlan('business_7500_monthly'), 7500);
  assert.equal(creditsForTopUp('credits_250'), 250);
});
