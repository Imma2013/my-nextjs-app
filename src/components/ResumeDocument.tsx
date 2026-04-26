type ResumeLike = { id?: string; title?: string; summary?: string; candidate_name?: string; headline?: string; parsed_json?: any } | null;
function arr(v: any): any[] { if (Array.isArray(v)) return v; if (typeof v === 'string') return v.split('\n').filter(Boolean); return []; }
function sec(p: any, k: string) { return arr(p?.sections?.[k] ?? p?.[k]); }
function text(x: any, fallback: string) { if (!x) return fallback; if (typeof x === 'string') return x; return x.role || x.title || x.name || x.degree || x.school || x.company || fallback; }
function bullets(x: any): string[] { if (!x) return []; if (typeof x === 'string') return [x]; const v = x.bullets || x.highlights || x.description || x.details || []; if (Array.isArray(v)) return v.map((y: any) => typeof y === 'string' ? y : JSON.stringify(y)); return typeof v === 'string' ? [v] : []; }
export default function ResumeDocument({ resume }: { resume: ResumeLike }) {
  const p = resume?.parsed_json || {};
  const c = p.contact || {};
  const exp = sec(p, 'experience');
  const edu = sec(p, 'education');
  const skills = sec(p, 'skills');
  const projects = sec(p, 'projects');
  const awards = sec(p, 'awards');
  const name = resume?.candidate_name || p.candidateName || p.name || 'Your Name';
  const headline = resume?.headline || p.headline || p.title || 'Resume';
  return <div className="mx-auto min-h-[900px] max-w-[850px] bg-white px-16 py-14 text-slate-800 shadow-sm ring-1 ring-slate-200">
    <div className="text-center border-b border-slate-200 pb-6 mb-6"><h1 className="font-serif text-3xl font-bold text-slate-800">{name}</h1><p className="mt-2 text-[11px] uppercase tracking-wide text-slate-500">{[c.location, c.email, c.phone].filter(Boolean).join(' • ') || headline}</p></div>
    <section className="mb-5"><h3 className="font-serif text-lg font-semibold uppercase text-slate-700 border-b border-slate-800">Experience</h3>{(exp.length ? exp : [{ role: 'Job Title', company: 'Company Name', bullets: ['Upload a resume to populate this live JSON preview.'] }]).map((item: any, idx: number) => <div key={idx} className="mt-3 text-sm"><div className="grid grid-cols-[1fr_auto] gap-x-4"><div><p className="font-semibold">{text(item, 'Job Title')}</p><p>{item.company || item.organization || ''}</p></div><p className="font-serif text-xs font-semibold uppercase text-right">{item.dates || item.date || item.duration || ''}</p></div><ul className="mt-1 list-disc pl-4 leading-6 text-slate-600">{bullets(item).map((b, i) => <li key={i}>{b}</li>)}</ul></div>)}</section>
    {projects.length > 0 && <section className="mb-5"><h3 className="font-serif text-lg font-semibold uppercase text-slate-700 border-b border-slate-800">Projects</h3>{projects.map((item: any, idx: number) => <div key={idx} className="mt-2 text-sm"><p className="font-semibold">{text(item, 'Project')}</p><ul className="list-disc pl-4 leading-6 text-slate-600">{bullets(item).map((b, i) => <li key={i}>{b}</li>)}</ul></div>)}</section>}
    <section className="mb-5"><h3 className="font-serif text-lg font-semibold uppercase text-slate-700 border-b border-slate-800">Education</h3>{(edu.length ? edu : ['Degree · College Name · Location']).map((item: any, idx: number) => <p key={idx} className="mt-2 text-sm text-slate-600">{typeof item === 'string' ? item : [item.degree, item.school || item.institution, item.location, item.dates].filter(Boolean).join(' · ')}</p>)}</section>
    <section className="mb-5"><h3 className="font-serif text-lg font-semibold uppercase text-slate-700 border-b border-slate-800">Skills</h3><p className="mt-2 text-sm text-slate-600">{skills.length ? skills.map((s: any) => typeof s === 'string' ? s : text(s, '')).join(' · ') : 'Skills will appear here after upload.'}</p></section>
    {awards.length > 0 && <section><h3 className="font-serif text-lg font-semibold uppercase text-slate-700 border-b border-slate-800">Awards</h3>{awards.map((item: any, idx: number) => <p key={idx} className="mt-2 text-sm text-slate-600">{text(item, '')}</p>)}</section>}
  </div>;
}
