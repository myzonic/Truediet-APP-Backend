import { db } from "./index.js";
import { content, plan, savedItem } from "./schema.js";
import { eq } from "drizzle-orm";
import { contentSeed } from "./content-seed.generated.js";

// The content library is generated from the app's own content modules by
// scripts/generate-content-seed.ts, so the database always holds
// the same articles, myths, recipes, resources, classes and episodes the app
// ships with.
type Seed = {
  slug: string;
  type: string;
  title: string;
  subtitle: string;
  category?: string;
  body?: string;
  durationMinutes?: number;
  episodeNumber?: number;
  listenUrl?: string;
  mediaUrl?: string;
  startsAt?: Date;
  isPremium?: boolean;
};

const items: Seed[] = contentSeed as Seed[];
// Plan catalogue. Prices stay null until the client supplies real provider
// product IDs - the server never invents an amount.
const plans: {
  code: string;
  name: string;
  interval: string;
  features: string[];
}[] = [
  {
    code: "foundations",
    name: "Nutrition Foundations",
    interval: "",
    features: ["Education package", "Core learning hub", "Selected resources"],
  },
  {
    code: "one-to-one",
    name: "One-to-One Nutrition Support",
    interval: "",
    features: ["Personalized RD guidance", "Secure messaging", "Video consultations"],
  },
  {
    code: "premium",
    name: "True Diet Premium",
    interval: "month",
    features: ["Expanded content", "Live classes", "Saved libraries"],
  },
];

export async function seedContent() {
  // Upsert rather than insert-and-ignore, so an edit to the app's content
  // modules actually reaches the database instead of being silently skipped
  // because the slug already exists.
  for (const item of items) {
    await db
      .insert(content)
      .values({
        slug: item.slug,
        type: item.type,
        title: item.title,
        subtitle: item.subtitle,
        category: item.category,
        body: item.body,
        durationMinutes: item.durationMinutes,
        episodeNumber: item.episodeNumber,
        listenUrl: item.listenUrl,
        mediaUrl: item.mediaUrl,
        startsAt: item.startsAt,
        isPremium: item.isPremium ?? false,
      })
      .onConflictDoUpdate({
        target: content.slug,
        set: {
          type: item.type,
          title: item.title,
          subtitle: item.subtitle,
          category: item.category,
          body: item.body,
          durationMinutes: item.durationMinutes,
          episodeNumber: item.episodeNumber,
          listenUrl: item.listenUrl,
          mediaUrl: item.mediaUrl,
          isPremium: item.isPremium ?? false,
          updatedAt: new Date(),
        },
      });
  }

  for (const item of plans) {
    await db
      .insert(plan)
      .values({
        code: item.code,
        name: item.name,
        interval: item.interval,
        currency: "USD",
        features: item.features,
        active: true,
      })
      .onConflictDoUpdate({
        target: plan.code,
        set: {
          name: item.name,
          interval: item.interval,
          currency: "USD",
          features: item.features,
          active: true,
        },
      });
  }

  await reconcileContentDuplicates();
}

/**
 * Reconciles duplicate content rows left behind when the generated slugs
 * changed between seed versions.
 *
 * The generated library is the source of truth: a row whose slug is not in
 * the current seed but whose title matches a seeded row is a duplicate. Any
 * saved_items link is repointed at the seeded row first, so nothing a member
 * saved is lost, and only then is the duplicate removed. Rows whose title
 * does not match anything in the seed are left alone.
 */
async function reconcileContentDuplicates() {
  const seedSlugs = new Set(items.map((i) => i.slug));
  const seedByTitle = new Map(items.map((i) => [i.title, i.slug]));

  const rows = await db
    .select({ id: content.id, slug: content.slug, title: content.title })
    .from(content);

  const toRemove = rows.filter((row) => {
    if (seedSlugs.has(row.slug)) return false;
    const canonical = seedByTitle.get(row.title);
    return Boolean(canonical) && canonical !== row.slug;
  });

  if (!toRemove.length) return;

  const canonicalBySlug = new Map(
    rows.filter((r) => seedSlugs.has(r.slug)).map((r) => [r.slug, r])
  );

  for (const dup of toRemove) {
    const canonical = canonicalBySlug.get(seedByTitle.get(dup.title)!);
    if (!canonical) continue;

    const saved = await db
      .select({ id: savedItem.id, userId: savedItem.userId })
      .from(savedItem)
      .where(eq(savedItem.contentId, dup.id));

    for (const link of saved) {
      const existing = await db
        .select({ id: savedItem.id })
        .from(savedItem)
        .where(eq(savedItem.contentId, canonical.id))
        .limit(1);

      if (existing.length) {
        // The member already saved the canonical row - drop the duplicate link.
        await db.delete(savedItem).where(eq(savedItem.id, link.id));
      } else {
        await db
          .update(savedItem)
          .set({ contentId: canonical.id })
          .where(eq(savedItem.id, link.id));
      }
    }

    await db.delete(content).where(eq(content.id, dup.id));
  }

  console.log(`Content seed: removed ${toRemove.length} duplicate row(s).`);
}
