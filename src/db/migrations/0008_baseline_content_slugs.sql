-- Rename the original seeded content slugs to the generated slugs so that
-- existing saved_items references keep pointing at the same content, and
-- remove the rows that the generated library supersedes.
--
-- The generated library uses prefixed slugs (article-*, topic-*, myth-*,
-- recipe-*, resource-*, webinar-*, podcast-*). The original seed used bare
-- slugs, so the same content exists under two names. This migration moves
-- the saved_items links across and deletes the now-unused duplicate rows.
--
-- Nothing here deletes user data: only content rows are removed, and only
-- after their saved_items links have been repointed.

DO $$
DECLARE
  legacy record;
  target_id uuid;
  legacy_id uuid;
  moved integer := 0;
  removed integer := 0;
BEGIN
  FOR legacy IN
    SELECT c.id, c.slug, c.title, c.type
      FROM content c
     WHERE c.slug IN (
       'what-healthy-eating-actually-means',
       'protein-context-over-hype',
       'how-to-evaluate-a-nutrition-claim',
       'label-reading-framework',
       'mindful-eating-guide',
       'seven-day-anti-inflammatory-reset',
       'nutrition-labels-without-fear',
       'building-balanced-meals',
       'nutrition-myths-think-clearly',
       'episode-12',
       'episode-11'
     )
  LOOP
    -- Find the generated row that carries the same title.
    SELECT id INTO target_id
      FROM content
     WHERE title = legacy.title
       AND slug LIKE legacy.type || '-%'
       AND id <> legacy.id
     LIMIT 1;

    IF target_id IS NOT NULL THEN
      -- Repoint any saved item to the generated content row.
      UPDATE saved_items
         SET content_id = target_id
       WHERE content_id = legacy.id
         AND NOT EXISTS (
           SELECT 1 FROM saved_items s2
            WHERE s2.user_id = saved_items.user_id
              AND s2.content_id = target_id
         );
      GET DIAGNOSTICS moved = ROW_COUNT;

      -- The duplicate row is now unreferenced and can be removed.
      DELETE FROM content WHERE id = legacy.id;
      GET DIAGNOSTICS removed = ROW_COUNT;
    END IF;
  END LOOP;

  RAISE NOTICE 'Baseline content: repointed % saved items, removed % duplicate content rows', moved, removed;
END $$;
