-- Remove content rows that the generated content library supersedes.
--
-- Earlier versions of the seed produced slightly different slugs for the
-- same content (for example `podcast-episode-11` and
-- `podcast-episode-11-finding-a-flexible-meal-rhythm`). The generated
-- library is now the single source of truth, so a row whose title matches a
-- canonical row but whose slug differs is a duplicate and is removed.
--
-- Saved item links are repointed to the canonical row first, so nothing a
-- member saved is lost. Only content rows are deleted.

DO $$
DECLARE
  duplicate record;
  canonical_id uuid;
BEGIN
  FOR duplicate IN
    SELECT c.id, c.slug, c.title
      FROM content c
     WHERE c.slug <> ALL (ARRAY[
       'article-nb-1','article-nb-2','article-nb-3',
       'article-eb-1','article-eb-2','article-eb-3',
       'article-mn-1','article-mn-2','article-mn-3',
       'article-fl-1','article-fl-2','article-fl-3',
       'article-my-1','article-my-2','article-my-3',
       'article-ps-1','article-ps-2','article-ps-3',
       'topic-nutrition-basics','topic-energy-balance','topic-macronutrients',
       'topic-food-labels','topic-myths','topic-peptides-supplements',
       'myth-carbs','myth-detox','myth-late-eating','myth-food-cutting',
       'myth-fat','myth-gluten','myth-metabolism','myth-protein','myth-sugar','myth-breakfast',
       'recipe-mediterranean-grain-bowl','recipe-salmon-veg-plate','recipe-overnight-oats',
       'recipe-lentil-veg-soup','recipe-yogurt-parfait','recipe-chickpea-cucumber-salad',
       'recipe-chicken-veg-stirfry','recipe-sheetpan-tofu-veg',
       'resource-label-reading-framework','resource-mindful-eating-guide',
       'resource-seven-day-anti-inflammatory-reset',
       'webinar-nutrition-labels-without-fear','webinar-building-balanced-meals',
       'webinar-nutrition-myths-think-clearly',
       'podcast-episode-12','podcast-episode-11','podcast-episode-10-protein-plainly'
     ])
  LOOP
    -- The canonical row is the one whose slug matches the generated library.
    SELECT id INTO canonical_id
      FROM content
     WHERE title = duplicate.title
       AND slug IN (
         'article-nb-1','article-nb-2','article-nb-3',
         'article-eb-1','article-eb-2','article-eb-3',
         'article-mn-1','article-mn-2','article-mn-3',
         'article-fl-1','article-fl-2','article-fl-3',
         'article-my-1','article-my-2','article-my-3',
         'article-ps-1','article-ps-2','article-ps-3',
         'topic-nutrition-basics','topic-energy-balance','topic-macronutrients',
         'topic-food-labels','topic-myths','topic-peptides-supplements',
         'myth-carbs','myth-detox','myth-late-eating','myth-food-cutting',
         'myth-fat','myth-gluten','myth-metabolism','myth-protein','myth-sugar','myth-breakfast',
         'recipe-mediterranean-grain-bowl','recipe-salmon-veg-plate','recipe-overnight-oats',
         'recipe-lentil-veg-soup','recipe-yogurt-parfait','recipe-chickpea-cucumber-salad',
         'recipe-chicken-veg-stirfry','recipe-sheetpan-tofu-veg',
         'resource-label-reading-framework','resource-mindful-eating-guide',
         'resource-seven-day-anti-inflammatory-reset',
         'webinar-nutrition-labels-without-fear','webinar-building-balanced-meals',
         'webinar-nutrition-myths-think-clearly',
         'podcast-episode-12','podcast-episode-11','podcast-episode-10-protein-plainly'
       )
       AND id <> duplicate.id
     LIMIT 1;

    IF canonical_id IS NOT NULL THEN
      UPDATE saved_items
         SET content_id = canonical_id
       WHERE content_id = duplicate.id
         AND NOT EXISTS (
           SELECT 1 FROM saved_items s2
            WHERE s2.user_id = saved_items.user_id
              AND s2.content_id = canonical_id
         );

      DELETE FROM content WHERE id = duplicate.id;
    END IF;
  END LOOP;
END $$;
