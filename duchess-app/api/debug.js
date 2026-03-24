const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler(req, res) {
  try {
    // Check if QDB7474 exists in Supabase
    const { data: job } = await supabase
      .from('crms_jobs')
      .select('id, crms_id, crms_ref, crms_state, crms_state_name, is_order')
      .eq('crms_ref', 'QDB7474')
      .single()

    
    // Count all jobs in Supabase
    const { count } = await supabase
      .from('crms_jobs')
      .select('*', { count: 'exact', head: true })

    // Sample of crms_state_name values
    const { data: states } = await supabase
      .from('crms_jobs')
      .select('crms_ref, crms_state, crms_state_name, is_order')
      .limit(10)

    return res.status(200).json({ 
      qdb7474_in_supabase: job,
      total_jobs_in_supabase: count,
      sample_states: states
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
Debug QDB7371 date fields
