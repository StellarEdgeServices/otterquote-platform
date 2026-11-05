-- gh-3245 referral-code gate: THROWAWAY additions on top of gh3239_throwaway_schema.sql (scratch Postgres 16 only).
-- get_or_create_customer_referral_code() reads public.profiles(id, full_name); production's table is far wider, this stub has only what the function reads.
\set ON_ERROR_STOP on
CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text);
GRANT EXECUTE ON FUNCTION public.get_or_create_customer_referral_code() TO authenticated;
