-- gh972: the drafted package revoked FROM anon but missed the implicit PUBLIC
-- grant (anon is a member of PUBLIC, so a bare `=X/postgres` ACL entry still
-- grants anon EXECUTE regardless of the explicit anon revoke). Same class of
-- gap #970's own migration correctly guarded against for its 6 functions;
-- #972's package missed applying that lesson to itself. Closing it now.
REVOKE EXECUTE ON FUNCTION public.get_contractor_quote_claim_ids(uuid) FROM PUBLIC;
