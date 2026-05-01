import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAtsResume, reviewAtsResume, validateAtsResume } from './resumeAts';
import { auditTailoredResume, canonicalizeTailoredResume, hasVisibleTailoringDiff } from './resumeTailorAudit';

const job = {
  title: 'Director',
  company_name: 'Chick-fil-A',
  description: 'Lead restaurant operations, scheduling, guest service, team coordination, communication, and food service experience.',
};

test('ATS cleanup normalizes Till Date to Present', () => {
  const normalized = normalizeAtsResume({
    experience: [{ role: 'Team Member', company: 'Six Flags', dates: 'June 2024 - Till Date', bullets: [] }],
  });

  assert.equal(normalized.experience[0].dates, 'June 2024 - Present');
});

test('ATS cleanup removes editor artifacts from skills', () => {
  const normalized = normalizeAtsResume({ skills: ['+ skill', '+ JavaScript'] });

  assert.deepEqual(normalized.skills, ['skill', 'JavaScript']);
});

test('ATS cleanup fixes known employer and school capitalization', () => {
  const normalized = normalizeAtsResume({
    experience: [{ role: 'Lead', company: 'Six flags', bullets: [] }],
    education: [{ school: 'middle school' }],
  });

  assert.equal(normalized.experience[0].company, 'Six Flags');
  assert.equal(normalized.education[0].school, 'Middle School');
});

test('ATS cleanup formats community service entries without losing facts', () => {
  const normalized = normalizeAtsResume({
    sections: {
      'community service': ['Tutor - Local Library - 2023 - Helped students with homework.'],
    },
  });

  assert.deepEqual(normalized.communityService[0], {
    role: 'Tutor',
    organization: 'Local Library',
    dates: '2023',
    bullets: ['Helped students with homework.'],
  });
});

test('ATS review keeps unsupported job keywords out and reports them missing', () => {
  const resume = {
    experience: [{ role: 'Cashier', bullets: ['Helped customers and organized inventory.'] }],
    skills: ['Customer service'],
  };
  const reviewed = reviewAtsResume(resume, 'Requires Microsoft Excel and Salesforce.');
  const visibleText = JSON.stringify(normalizeAtsResume(resume));

  assert.doesNotMatch(visibleText, /Microsoft Excel|Salesforce/i);
  assert.ok(reviewed.missingKeywords.includes('Microsoft Excel'));
  assert.ok(reviewed.missingKeywords.includes('Salesforce'));
});

test('ATS cleanup preserves uncertain project casing', () => {
  const normalized = normalizeAtsResume({
    projects: [{ title: 'ATProtocol demo', bullets: ['Built a prototype.'] }],
  });

  assert.equal(normalized.projects[0].title, 'ATProtocol demo');
});

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
