import assert from 'node:assert/strict';
import test from 'node:test';
import { auditTailoredResume, canonicalizeTailoredResume, hasVisibleTailoringDiff } from './resumeTailorAudit';

const job = {
  title: 'Director',
  company_name: 'Chick-fil-A',
  description: 'Lead restaurant operations, scheduling, guest service, team coordination, communication, and food service experience.',
};

test('canonicalization promotes rewritten hidden fields into visible bullets', () => {
  const source = {
    experience: [
      { role: 'Lead', company: 'Six Flags', bullets: ['Helped guests and supported daily park operations.'] },
    ],
  };
  const candidate = {
    experience: [
      {
        role: 'Changed title',
        company: 'Changed company',
        bullets: ['Helped guests and supported daily park operations.'],
        highlights: ['Coordinated team tasks, schedules, and guest support during daily operations.'],
      },
    ],
  };

  const canonical = canonicalizeTailoredResume(source, candidate);

  assert.deepEqual(canonical.experience[0].bullets, [
    'Coordinated team tasks, schedules, and guest support during daily operations.',
  ]);
  assert.equal(hasVisibleTailoringDiff(source, canonical), true);
});

test('leadership clarification facts can appear in audited visible bullets while unsupported food service stays missing', () => {
  const source = {
    summary: 'Student leader with service experience.',
    experience: [
      { role: 'Lead', company: 'Six Flags', dates: '2024', bullets: ['Helped guests and supported daily park operations.'] },
      { role: 'Trumpet Instructor', company: 'Private Lessons', dates: '2023', bullets: ['Taught trumpet lessons.'] },
    ],
  };
  const candidate = {
    summary: 'Operations-minded student leader with guest support, team coordination, and teaching experience.',
    experience: [
      {
        role: 'Lead',
        company: 'Six Flags',
        dates: '2024',
        highlights: [
          'Coordinated task assignments, schedule coverage, team direction, operational support, and guest assistance.',
        ],
      },
      {
        role: 'Trumpet Instructor',
        company: 'Private Lessons',
        dates: '2023',
        description: 'Mentored a student by teaching practice methods and supporting steady student development.',
      },
    ],
  };

  const audited = auditTailoredResume({
    sourceParsed: source,
    tailoredParsed: candidate,
    job,
    answers: [
      {
        questionId: 'six_flags',
        question: 'What leadership work did you do at Six Flags?',
        answer: 'I assigned tasks, coordinated schedules, directed the team, supported operations, and helped guests.',
      },
      {
        questionId: 'trumpet',
        question: 'What did you do as a trumpet instructor?',
        answer: 'I mentored a student, taught practice methods, and supported student development.',
      },
    ],
    gemini: {
      score: 82,
      matchedKeywords: ['Leadership', 'Operations', 'Communication'],
      missingKeywords: ['Food service experience'],
    },
    fallbackSummary: 'Tailored for Director.',
  });

  const visibleText = JSON.stringify(audited.parsed);

  assert.match(visibleText, /task assignments/i);
  assert.match(visibleText, /schedule coverage/i);
  assert.match(visibleText, /guest assistance/i);
  assert.match(visibleText, /practice methods/i);
  assert.ok(audited.missingKeywords.some(keyword => /food service/i.test(keyword)));
  assert.deepEqual(audited.improvements, [
    'Rewrote the profile using supported resume facts for the target role.',
    'Refocused existing experience bullets on relevant, supported responsibilities.',
  ]);
});

test('uncertain answers are ignored and unsupported technical claims are stripped from visible fields', () => {
  const source = {
    summary: 'Customer service worker.',
    experience: [
      { role: 'Cashier', company: 'Store', bullets: ['Helped customers and kept the workspace organized.'] },
    ],
    skills: ['Customer service'],
  };
  const tailored = {
    summary: 'React-focused customer service worker.',
    experience: [
      {
        role: 'Cashier',
        company: 'Store',
        highlights: ['Built React production systems while helping customers.'],
      },
    ],
    skills: ['Customer service', 'React'],
  };

  const audited = auditTailoredResume({
    sourceParsed: source,
    tailoredParsed: tailored,
    job: { title: 'React Developer', description: 'React and customer service.' },
    answers: [{ questionId: 'react', answer: 'I am not sure' }],
    gemini: { score: 90, matchedKeywords: ['React', 'Customer service'], missingKeywords: [] },
    fallbackSummary: 'Tailored for React Developer.',
  });

  const visibleText = JSON.stringify(audited.parsed);

  assert.doesNotMatch(visibleText, /React/i);
  assert.ok(audited.missingKeywords.includes('React'));
  assert.ok(audited.score <= 65);
});
