-- v12: Contract Templates
-- Add support for multiple contract templates per trade/funding type combination
-- Contractors can upload different templates for different types of work

ALTER TABLE contractors ADD COLUMN IF NOT EXISTS contract_templates JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN contractors.contract_templates IS 'Array of {trade, funding_type, file_url, file_name, uploaded_at} objects. Stores URLs and metadata for templates uploaded for different trade/funding type combinations.';
