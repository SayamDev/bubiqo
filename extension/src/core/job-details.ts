/**
 * The things a job advert is actually about.
 *
 * A salary and a closing date are not why anyone reads an advert. They read it to
 * find out whether they can do the job and whether they are allowed to — and the
 * deal-breakers are usually buried three-quarters of the way down, under a
 * heading like "Security requirements" or "To Be Eligible, You Must".
 *
 * Both lists are closed vocabularies rather than open-ended guesses. A named
 * technology either appears or it does not; a requirement either matches a known
 * phrasing or it does not. That is testable, and it will not invent a skill the
 * advert never mentioned — which on a job application matters more than coverage.
 */

/**
 * Technologies worth naming. Ordered so that longer names are matched first —
 * otherwise "Java" swallows the start of "JavaScript".
 */
const SKILLS: readonly string[] = [
  "TypeScript", "JavaScript", "Node.js", "React Native", "React", "Vue", "Angular", "Svelte",
  "Next.js", "Nuxt", "Redux", "GraphQL", "REST", "HTML", "CSS", "SCSS", "Sass", "Tailwind",
  "Java", "Kotlin", "Swift", "Objective-C", "C#", ".NET", "Python", "Django", "Flask", "FastAPI",
  "Ruby", "Rails", "Go", "Golang", "Rust", "PHP", "Laravel", "Scala", "Elixir", "Perl",
  "AWS", "Azure", "GCP", "Google Cloud", "Kubernetes", "Docker", "Terraform", "Ansible",
  "GitLab", "GitHub Actions", "Jenkins", "CircleCI", "CI/CD", "DevOps", "Infrastructure as Code",
  "PostgreSQL", "MySQL", "MongoDB", "Redis", "Elasticsearch", "DynamoDB", "SQL", "NoSQL",
  "Kafka", "RabbitMQ", "Spark", "Hadoop", "Airflow", "dbt", "Snowflake",
  "Agile", "Scrum", "Kanban", "TDD", "Microservices", "Serverless",
  "Figma", "Accessibility", "WCAG", "SEO",
  "Machine Learning", "TensorFlow", "PyTorch", "LLM",
];

export interface FoundSkill {
  readonly name: string;
  readonly mentions: number;
}

/**
 * Named technologies the advert actually mentions, most-mentioned first.
 *
 * Repetition is the signal that separates what the job is built on from what it
 * merely touches: an advert that says React four times wants a React developer.
 */
export function findSkills(text: string): FoundSkill[] {
  const found: FoundSkill[] = [];

  for (const skill of SKILLS) {
    // Escaped, and bounded so "Go" does not match "Going" and "React" does not
    // match "Reactive".
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundary = /^[A-Za-z]/.test(skill) ? "\\b" : "";
    const trailing = /[A-Za-z]$/.test(skill) ? "\\b" : "";
    const pattern = new RegExp(`${boundary}${escaped}${trailing}`, "gi");

    const mentions = (text.match(pattern) ?? []).length;
    if (mentions > 0) found.push({ name: skill, mentions });
  }

  /*
   * No containment filtering. The word boundaries above already do that job —
   * \bJava\b does not match inside "JavaScript", and \bGo\b does not match inside
   * "Golang" or "Going". An earlier version compared mention counts to drop
   * shorter names, and dropped "Java" from an advert that asked for "Strong
   * commercial Java development experience", because JavaScript was named more
   * often. Two languages, both wanted, and one silently discarded.
   */
  return found.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name));
}

export interface FoundRequirement {
  /** Shown to the user, in their words not the advert's. */
  readonly summary: string;
  /** The sentence it came from, so the claim can be checked. */
  readonly evidence: string;
  /** True when failing it rules the reader out entirely. */
  readonly blocking: boolean;
}

interface RequirementRule {
  readonly pattern: RegExp;
  readonly summary: string;
  readonly blocking: boolean;
}

/**
 * The conditions that decide whether applying is worth the hour it takes.
 *
 * Security clearance and nationality are at the top because they are absolute:
 * no amount of relevant experience compensates for not being eligible, and an
 * advert that mentions them halfway down has effectively hidden them.
 */
const REQUIREMENT_RULES: readonly RequirementRule[] = [
  { pattern: /\b(?:security clearance|SC cleared|DV cleared|developed vetting|BPSS|NPPV|counter[- ]terrorist check)\b/i,
    summary: "Security clearance required", blocking: true },
  /*
   * Adverts state this as a bullet — "Be a British citizen" — under a heading like
   * "To Be Eligible, You Must", so requiring the word "must" adjacent to it missed
   * the real phrasing entirely.
   */
  { pattern: /\bBritish citizen(?:ship)?\b|\bsole British national\b|\bmust be (?:a )?UK citizen\b/i,
    summary: "Must be a British citizen", blocking: true },
  { pattern: /\b(?:lived|resided) (?:permanently |continuously )?in the UK for (?:the last |at least )?\w+ years?\b/i,
    summary: "UK residency period required", blocking: true },
  { pattern: /\b(?:right to work|work permit|visa sponsorship is not|cannot sponsor|no sponsorship|unable to sponsor)\b/i,
    summary: "Right to work restrictions", blocking: true },
  { pattern: /\b(?:full|valid|clean)\s+(?:UK\s+)?driving licence\b/i,
    summary: "Driving licence required", blocking: true },
  { pattern: /\b(?:DBS check|enhanced DBS|criminal record check)\b/i,
    summary: "DBS check required", blocking: true },
  { pattern: /\b(\d+)\+?\s*years?(?:'|’)?\s*(?:of\s+)?(?:commercial\s+|professional\s+)?experience\b/i,
    summary: "Minimum years of experience", blocking: false },
  { pattern: /\b(?:degree|BSc|MSc|PhD|bachelor|master)(?:'s)?\b[^.\n]{0,40}\b(?:required|essential|must)\b/i,
    summary: "Degree required", blocking: false },
  { pattern: /\b(?:\d+\s*days?\s*(?:per week\s*)?(?:on[- ]?site|in (?:the )?office)|fully on[- ]?site)\b/i,
    summary: "On-site days required", blocking: false },
];

export function findRequirements(text: string): FoundRequirement[] {
  const found: FoundRequirement[] = [];

  for (const rule of REQUIREMENT_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;

    const at = match.index;
    const start = Math.max(0, text.lastIndexOf(".", at) + 1);
    const endMarker = text.indexOf(".", at + match[0].length);
    const end = endMarker === -1 ? Math.min(text.length, at + 160) : endMarker + 1;

    found.push({
      summary: rule.summary,
      evidence: text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 180),
      blocking: rule.blocking,
    });
  }

  // Blocking conditions first: they decide whether the rest is worth reading.
  return found.sort((a, b) => Number(b.blocking) - Number(a.blocking));
}
