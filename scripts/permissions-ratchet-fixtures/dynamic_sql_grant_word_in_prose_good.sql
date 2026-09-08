-- RATCHET-FIXTURE: EXPECT=PASS
-- The word GRANT appearing in ordinary prose text -- no "TO <role>" shape
-- anywhere in the same literal -- must not trip rule 4. Distinguishes
-- "this literal contains the word GRANT" from "this literal contains a
-- GRANT ... TO <role> statement": rule 4's regex requires a TO clause
-- after GRANT, which this text never has.
BEGIN;

INSERT INTO audit_log(msg) VALUES ('reviewed the GRANT policy');

COMMIT;
