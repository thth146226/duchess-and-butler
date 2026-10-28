import { createClient } from '@supabase/supabase-js'

const driverPortalAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjb3N4YW1qdnh2ZWF3YWVsdW1hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNDY2MjIsImV4cCI6MjA4ODgyMjYyMn0.UkMQcQGovE5aX9znOeG1MtJ1_5FWA7kc5WNAE6HeBOw'

export const driverPortalSupabase = createClient(
  'https://ecosxamjvxveawaeluma.supabase.co',
  driverPortalAnonKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'driver-portal-auth',
    },
    global: {
      headers: {
        apikey: driverPortalAnonKey,
        Authorization: `Bearer ${driverPortalAnonKey}`,
      },
    },
  }
)
