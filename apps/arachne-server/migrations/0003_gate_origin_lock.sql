-- Arachne gate relay — lock a gate's origin once set (M9: cross-origin squat).
-- gates.id is a global PRIMARY KEY, so two origins can never both INSERT the same
-- id; the second push hits ON CONFLICT. The application's ON CONFLICT WHERE clause
-- already refuses to mutate a row whose origin differs from the authenticated
-- pusher, but this trigger is the structural backstop: no UPDATE may ever change
-- an existing gate's origin, so a foreign-origin row can never be retargeted to
-- another platform regardless of the calling code path.
--
-- Apply to production: paste into the Fly Postgres (or run via applyMigration).
-- Re-running is a clean no-op.

CREATE OR REPLACE FUNCTION gates_origin_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'gate origin is immutable (% -> %)', OLD.origin, NEW.origin;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gates_origin_immutable ON gates;
CREATE TRIGGER trg_gates_origin_immutable
  BEFORE UPDATE ON gates
  FOR EACH ROW
  EXECUTE FUNCTION gates_origin_immutable();
