import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://ecosxamjvxveawaeluma.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjb3N4YW1qdnh2ZWF3YWVsdW1hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNDY2MjIsImV4cCI6MjA4ODgyMjYyMn0.UkMQcQGovE5aX9znOeG1MtJ1_5FWA7kc5WNAE6HeBOw'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// Note: this file exports a shared Supabase client.
