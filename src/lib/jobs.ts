export type JobApplyOption = {
  title?: string;
  link?: string;
};

export type JobResult = {
  title?: string;
  company_name?: string;
  location?: string;
  description?: string;
  extensions?: string[];
  thumbnail?: string;
  apply_options?: JobApplyOption[];
  share_link?: string;
};

export type JobSearchPayload = {
  query: string;
  jobs: JobResult[];
};

function normalizeJob(job: any): JobResult {
  return {
    title: job?.title,
    company_name: job?.company_name,
    location: job?.location,
    description: job?.description,
    extensions: Array.isArray(job?.extensions) ? job.extensions : [],
    thumbnail: job?.thumbnail,
    apply_options: Array.isArray(job?.apply_options)
      ? job.apply_options.map((option: any) => ({
          title: option?.title,
          link: option?.link,
        }))
      : [],
    share_link: job?.share_link,
  };
}

export async function searchJobs(query: string): Promise<JobSearchPayload> {
  const apiKey = process.env.SERPAPI_API_KEY;

  if (!apiKey) {
    throw new Error('SERPAPI_API_KEY is not configured on the server');
  }

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_jobs');
  url.searchParams.set('google_domain', 'google.com');
  url.searchParams.set('hl', 'en');
  url.searchParams.set('gl', 'us');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('q', query);

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error || 'Failed to fetch from SerpApi');
  }

  return {
    query,
    jobs: Array.isArray(data?.jobs_results) ? data.jobs_results.map(normalizeJob) : [],
  };
}
