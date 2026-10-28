-- Remove content rows that the generated content library supersedes.
--
-- Earlier versions of the seed produced slightly different slugs for the
-- same content (for example `podcast-episode-11` and
-- `podcast-episode-11-finding-a-flexible-meal-rhythm`). The generated
-- library is now the single source of truth, so any row whose title matches
-- a generated row but whose slug does not is a duplicate and is removed.
--
-- Saved item links are repointed to the canonical row first, so nothing a
-- member saved is lost. Only content rows are deleted.

DO $$
DECLARE
  duplicate record;
  canonical_id uuid;
  duplicate_id uuid;
BEGIN
  FOR duplicate IN
    SELECT c.id, c.slug, c.title
      FROM content c
     WHERE c.slug NOT LIKE 'article-%'
       AND c.slug NOT LIKE 'topic-%'
       AND c.slug NOT LIKE 'myth-%'
       AND c.slug NOT LIKE 'recipe-%'
       AND c.slug NOT LIKE 'resource-%'
       AND c.slug NOT LIKE 'webinar-%'
       AND c.slug NOT LIKE 'podcast-%'
  LOOP
    SELECT id INTO canonical_id
      FROM content
     WHERE title = duplicate.title
       AND slug LIKE ANY (ARRAY['article-%','topic-%','myth-%','recipe-%','resource-%','webinar-%','podcast-%'])
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
