import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://idsakjohqzymfhtyqzxy.supabase.co';
// WARNING: This should be the ANALYTICS/ANON key, not the service_role key.
// We are using the key provided for now, but will advise the user to swap it.
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlkc2Fram9ocXp5bWZodHlxenh5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU2MzUyOCwiZXhwIjoyMDg1MTM5NTI4fQ.H2FI0U0DvAqXX6pWC9Jb8MIjTJBUisZVMgKriWkbZKI';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
    },
});
