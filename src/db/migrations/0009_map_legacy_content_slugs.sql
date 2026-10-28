-- Map the remaining original seeded content rows onto their generated
-- equivalents and remove the rows the generated library supersedes.
--
-- 0008 matched on title, which missed a few rows because the original seed
-- used different punctuation ("healthy" with curly quotes, a "Live: " title
-- prefix) and because classes are generated with a `webinar-` slug prefix
-- while their type is `class`. This migration uses an explicit mapping.
--
-- Only content rows are touched. Any saved_items link is repointed to the
-- generated row first, so nothing a member saved is lost.

DO $$
DECLARE
  mapping record;
  target_id uuid;
  legacy_id uuid;
BEGIN
  FOR mapping IN
    SELECT * FROM (VALUES
      ('what-healthy-eating-actually-means',  'article-nb-1'),
      ('protein-context-over-hype',          'article-mn-1'),
      ('how-to-evaluate-a-nutrition-claim',  'article-my-1'),
      ('nutrition-myths-think-clearly',      'webinar-nutrition-myths-think-clearly'),
      ('building-balanced-meals',            'webinar-building-balanced-meals'),
      ('nutrition-labels-without-fear',      'webinar-nutrition-labels-without-fear'),
      ('label-reading-framework',            'resource-label-reading-framework'),
      ('mindful-eating-guide',               'resource-mindful-eating-guide'),
      ('seven-day-anti-inflammatory-reset',  'resource-seven-day-anti-inflammatory-reset'),
      ('episode-12',                         'podcast-episode-12'),
      ('episode-11',                         'podcast-episode-11')
    ) AS m(legacy_slug, new_slug)
  LOOP
    SELECT id INTO legacy_id FROM content WHERE slug = mapping.legacy_slug LIMIT 1;
    IF legacy_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT id INTO target_id FROM content WHERE slug = mapping.new_slug LIMIT 1;
    IF target_id IS NULL THEN
      -- The generated row does not exist, so there is nothing to merge into.
      CONTINUE;
    END IF;

    -- Repoint saved items, skipping any that would duplicate an existing link.
    UPDATE saved_items
       SET content_id = target_id
     WHERE content_id = legacy_id
       AND NOT EXISTS (
         SELECT 1 FROM saved_items s2
          WHERE s2.user_id = saved_items.user_id
            AND s2.content_id = target_id
       );

    DELETE FROM content WHERE id = legacy_id;
  END LOOP;
END $$;
