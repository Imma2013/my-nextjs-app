import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAtsResume } from './resumeAts';
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

test('unsupported ATS job tools are stripped and reported as missing keywords', () => {
  const source = {
    summary: 'Customer service worker.',
    experience: [
      { role: 'Cashier', company: 'Store', dates: '2023', bullets: ['Helped customers and kept the workspace organized.'] },
    ],
    education: ['High School Diploma'],
    skills: ['Customer service'],
  };
  const tailored = {
    summary: 'Customer service worker with Microsoft Excel reporting experience.',
    experience: [
      { role: 'Cashier', company: 'Store', dates: '2023', bullets: ['Used Microsoft Excel to track inventory and sales reports.'] },
    ],
    skills: ['Customer service', 'Microsoft Excel'],
  };

  const audited = auditTailoredResume({
    sourceParsed: source,
    tailoredParsed: tailored,
    job: { title: 'Office Assistant', description: 'Requires customer service, data entry, and Microsoft Excel.' },
    answers: [],
    gemini: { score: 88, matchedKeywords: ['Microsoft Excel'], missingKeywords: [] },
    fallbackSummary: 'Tailored for Office Assistant.',
  });

  const visibleText = JSON.stringify(audited.parsed);

  assert.doesNotMatch(visibleText, /Microsoft Excel/i);
  assert.ok(audited.missingKeywords.includes('Microsoft Excel'));
});

test('ATS validation reports job keywords missing from the resume', () => {
  const result = validateAtsResume({
    contact: { email: 'person@example.com', phone: '555-555-5555' },
    experience: [{ role: 'Cashier', dates: '2023', bullets: ['Helped customers.'] }],
    education: ['High School Diploma'],
    skills: ['Customer service'],
  }, 'This role requires Microsoft Excel and a ServSafe certification.');

  assert.ok(result.missingKeywords.includes('Microsoft Excel'));
  assert.ok(result.missingKeywords.some(keyword => /servsafe/i.test(keyword)));
});
