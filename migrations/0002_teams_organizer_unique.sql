-- Databases that already applied 0001 before organizer_id was UNIQUE still need
-- the constraint.  Fresh databases get it from the column definition as well.
CREATE UNIQUE INDEX IF NOT EXISTS teams_organizer_unique ON teams(organizer_id);
