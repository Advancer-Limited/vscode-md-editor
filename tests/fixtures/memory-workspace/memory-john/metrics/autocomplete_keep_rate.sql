SELECT date(created_at) AS day FROM events WHERE name IN ('ghost_text_shown', 'ghost_text_kept') GROUP BY day;
