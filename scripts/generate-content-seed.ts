/**
 * Generates the content-library seed for the database from the app's own
 * content modules, so `content` holds every article, myth, recipe, resource,
 * webinar and episode instead of a hand-written subset.
 *
 *   npx tsx scripts/generate-content-seed.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const repoRoot = path.resolve(serverRoot, "..");

const importClient = (relative: string) =>
  import(pathToFileURL(path.join(repoRoot, relative)).href);

const { learnTopics } = await importClient("src/lib/learnContent.ts");
const { myths } = await importClient("src/lib/mythContent.ts");
const { recipes } = await importClient("src/lib/recipeContent.ts");
const { hubItems, webinarSessions, podcastEpisodes, slugify } = await importClient(
  "src/lib/libraryContent.ts"
);

const disclaimer =
  "\n\n> True Diet provides education, not diagnosis or medical nutrition therapy.";

type Seed = {
  slug: string;
  type: string;
  title: string;
  subtitle: string;
  category?: string;
  body: string;
  durationMinutes?: number;
  episodeNumber?: number;
  listenUrl?: string;
  mediaUrl?: string;
  isPremium?: boolean;
};

const items: Seed[] = [];

// Articles, grouped by topic. The topic becomes the category so the
// database keeps the same grouping the app shows.
for (const topic of learnTopics as any[]) {
  for (const article of topic.articles ?? []) {
    const body = [
      `# ${article.title}`,
      article.summary,
      ...(article.sections ?? []).map((s: any) => `## ${s.heading}\n${s.body}`),
    ].join("\n\n");
    items.push({
      slug: `article-${article.id}`,
      type: "article",
      title: article.title,
      subtitle: `${topic.title} · ${article.readTime} read`,
      category: topic.title,
      body: body + disclaimer,
      durationMinutes: Number.parseInt(String(article.readTime), 10) || undefined,
    });
  }
}

// Topics themselves, so the topic list can come from the database.
for (const topic of learnTopics as any[]) {
  items.push({
    slug: `topic-${topic.slug}`,
    type: "topic",
    title: topic.title,
    subtitle: topic.subtitle,
    category: topic.title,
    body: `${topic.intro}${disclaimer}`,
  });
}

// Myths.
for (const myth of myths as any[]) {
  const body = [
    `# ${myth.claim}`,
    `**${myth.label}**`,
    myth.short,
    `## What is true\n${myth.whatIsTrue}`,
    `## Why it spreads\n${myth.whyItSpreads}`,
    `## The evidence\n${myth.evidence}`,
    `## Takeaway\n${myth.takeaway}`,
  ].join("\n\n");
  items.push({
    slug: `myth-${myth.id}`,
    type: "myth",
    title: myth.claim,
    subtitle: myth.label,
    category: "Nutrition Truth",
    body: body + disclaimer,
    durationMinutes: 5,
  });
}

// Recipes.
for (const recipe of recipes as any[]) {
  const body = [
    `# ${recipe.title}`,
    `**${recipe.time} · ${recipe.category}**`,
    `## Why it works\n${recipe.whyItWorks}`,
    `## Ingredients\n${(recipe.ingredients ?? []).map((i: string) => `- ${i}`).join("\n")}`,
    `## Method\n${(recipe.steps ?? []).map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`,
    `## Tip\n${recipe.tip}`,
  ].join("\n\n");
  items.push({
    slug: `recipe-${recipe.id}`,
    type: "recipe",
    title: recipe.title,
    subtitle: `${recipe.time} · ${recipe.category}`,
    category: recipe.category,
    body: body + disclaimer,
    durationMinutes: Number.parseInt(String(recipe.time), 10) || undefined,
  });
}

// Resources - the copy the app already ships.
for (const item of hubItems as any[]) {
  if (item.route !== 'ResourceDetail') continue;
  items.push({
    slug: `resource-${slugify(item.title)}`,
    type: "resource",
    title: item.title,
    subtitle: item.subtitle,
    category: "Resource",
    body: `# ${item.title}\n\n${item.subtitle}.${disclaimer}`,
  });
}

// Webinars and recorded classes.
for (const session of webinarSessions as any[]) {
  const minutes = Number.parseInt(String(session.detail), 10) || undefined;
  items.push({
    slug: `webinar-${slugify(session.title)}`,
    type: session.live ? 'webinar' : 'class',
    title: session.title,
    subtitle: session.meta,
    category: session.live ? "Live webinar" : "Recorded class",
    body: `# ${session.title}\n\n${session.detail}.${disclaimer}`,
    durationMinutes: minutes,
    isPremium: !session.live,
  });
}

// Podcast episodes.
for (const episode of podcastEpisodes as any[]) {
  const minutes = Number.parseInt(String(episode.meta), 10) || undefined;
  const number = Number.parseInt(String(episode.id).replace(/\D/g, ''), 10) || undefined;
  items.push({
    slug: `podcast-${slugify(episode.title)}`,
    type: "podcast",
    title: episode.title,
    subtitle: episode.meta,
    category: "Podcast",
    body: `# ${episode.title}\n\n${episode.meta}.${disclaimer}`,
    durationMinutes: minutes,
    episodeNumber: number,
  });
}

const outFile = path.join(serverRoot, "src/db/content-seed.generated.ts");
const body = items
  .map((item) => {
    const fields = [
      `slug: ${JSON.stringify(item.slug)}`,
      `type: ${JSON.stringify(item.type)}`,
      `title: ${JSON.stringify(item.title)}`,
      `subtitle: ${JSON.stringify(item.subtitle)}`,
      item.category ? `category: ${JSON.stringify(item.category)}` : null,
      `body: ${JSON.stringify(item.body)}`,
      item.durationMinutes ? `durationMinutes: ${item.durationMinutes}` : null,
      item.episodeNumber ? `episodeNumber: ${item.episodeNumber}` : null,
      item.isPremium ? `isPremium: ${item.isPremium}` : null,
    ]
      .filter(Boolean)
      .join(",\n    ");
    return `  {\n    ${fields},\n  }`;
  })
  .join(",\n");

fs.writeFileSync(
  outFile,
  `// AUTO-GENERATED by scripts/generate-content-seed.ts - do not edit by hand.\n` +
    `// Run "npx tsx scripts/generate-content-seed.ts" after changing the app's\n` +
    `// content modules so the database stays in step with the app.\n\n` +
    `export type ContentSeed = {\n` +
    `  slug: string;\n  type: string;\n  title: string;\n  subtitle: string;\n` +
    `  category?: string;\n  body: string;\n  durationMinutes?: number;\n` +
    `  episodeNumber?: number;\n  isPremium?: boolean;\n};\n\n` +
    `export const contentSeed: ContentSeed[] = [\n${body},\n];\n`
);

const byType = items.reduce((acc: Record<string, number>, item) => {
  acc[item.type] = (acc[item.type] ?? 0) + 1;
  return acc;
}, {});

console.log(`Wrote ${items.length} content rows to ${outFile}`);
console.log(JSON.stringify(byType, null, 2));
