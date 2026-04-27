'use client';
import { useEffect, useState } from 'react';

type Contact = { full_name?: string; email?: string; phone?: string; location?: string; linkedin?: string; portfolio?: string };
type Summary = { content?: string };
type Skills = { skills?: string[] };
type Experience = { id: string; title: string; company: string; location?: string; start_date?: string; end_date?: string; is_current?: boolean; bullets?: string[] };
type Education = { id: string; degree: string; school: string; location?: string; start_date?: string; end_date?: string; gpa?: string; bullets?: string[] };
type Project = { id: string; title: string; description?: string; technologies?: string[]; link?: string; bullets?: string[] };

type ResumeData = {
  contact: Contact | null;
  summary: Summary | null;
  skills: Skills | null;
  experience: Experience[];
  education: Education[];
  projects: Project[];
};

export default function ResumePreview({ resumeId }: { resumeId: string }) {
  const [data, setData] = useState<ResumeData | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchResume() {
    try {
      const res = await fetch(`/api/resume/get?resume_id=${resumeId}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchResume();
    // Poll every 2 seconds for updates
    const interval = setInterval(fetchResume, 2000);
    return () => clearInterval(interval);
  }, [resumeId]);

  if (loading) return <div className="p-4 text-white/40 text-sm">Loading resume...</div>;
  if (!data) return <div className="p-4 text-white/40 text-sm">No resume data</div>;

  return (
    <div className="bg-white text-black p-8 rounded-lg shadow-lg max-w-3xl mx-auto text-sm leading-relaxed">
      {/* Header */}
      <div className="text-center mb-6 border-b pb-4">
        <h1 className="text-2xl font-bold">{data.contact?.full_name || 'Your Name'}</h1>
        <div className="text-xs text-gray-600 mt-1 space-x-2">
          {data.contact?.location && <span>{data.contact.location}</span>}
          {data.contact?.email && <span>• {data.contact.email}</span>}
          {data.contact?.phone && <span>• {data.contact.phone}</span>}
        </div>
        {(data.contact?.linkedin || data.contact?.portfolio) && (
          <div className="text-xs text-blue-600 mt-1 space-x-2">
            {data.contact?.linkedin && <a href={data.contact.linkedin} className="underline">LinkedIn</a>}
            {data.contact?.portfolio && <a href={data.contact.portfolio} className="underline">Portfolio</a>}
          </div>
        )}
      </div>

      {/* Summary */}
      {data.summary?.content && (
        <div className="mb-6">
          <h2 className="text-sm font-bold uppercase border-b border-gray-300 pb-1 mb-2">Professional Summary</h2>
          <p className="text-xs text-gray-700">{data.summary.content}</p>
        </div>
      )}

      {/* Experience */}
      {data.experience.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-bold uppercase border-b border-gray-300 pb-1 mb-2">Experience</h2>
          {data.experience.map(exp => (
            <div key={exp.id} className="mb-4">
              <div className="flex justify-between items-baseline">
                <div>
                  <h3 className="font-bold text-xs">{exp.title}</h3>
                  <p className="text-xs text-gray-600">{exp.company}{exp.location ? `, ${exp.location}` : ''}</p>
                </div>
                <p className="text-xs text-gray-500">
                  {exp.start_date} - {exp.is_current ? 'Present' : exp.end_date}
                </p>
              </div>
              {exp.bullets && exp.bullets.length > 0 && (
                <ul className="list-disc ml-5 mt-1 text-xs text-gray-700 space-y-0.5">
                  {exp.bullets.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Education */}
      {data.education.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-bold uppercase border-b border-gray-300 pb-1 mb-2">Education</h2>
          {data.education.map(edu => (
            <div key={edu.id} className="mb-3">
              <div className="flex justify-between items-baseline">
                <div>
                  <h3 className="font-bold text-xs">{edu.degree}</h3>
                  <p className="text-xs text-gray-600">{edu.school}{edu.location ? `, ${edu.location}` : ''}</p>
                </div>
                <p className="text-xs text-gray-500">
                  {edu.start_date} - {edu.end_date}
                </p>
              </div>
              {edu.gpa && <p className="text-xs text-gray-600 mt-0.5">GPA: {edu.gpa}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Skills */}
      {data.skills?.skills && data.skills.skills.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-bold uppercase border-b border-gray-300 pb-1 mb-2">Skills</h2>
          <p className="text-xs text-gray-700">{data.skills.skills.join(', ')}</p>
        </div>
      )}

      {/* Projects */}
      {data.projects.length > 0 && (
        <div>
          <h2 className="text-sm font-bold uppercase border-b border-gray-300 pb-1 mb-2">Projects</h2>
          {data.projects.map(proj => (
            <div key={proj.id} className="mb-3">
              <h3 className="font-bold text-xs">{proj.title}</h3>
              {proj.description && <p className="text-xs text-gray-600 mt-0.5">{proj.description}</p>}
              {proj.technologies && proj.technologies.length > 0 && (
                <p className="text-xs text-gray-500 mt-0.5">Tech: {proj.technologies.join(', ')}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}