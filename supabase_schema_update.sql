-- 1. Add user_id column to transactions table
ALTER TABLE transactions 
ADD COLUMN user_id UUID REFERENCES auth.users(id);

-- 2. (Optional) Set user_id for existing transactions if you want to keep them
-- UPDATE transactions SET user_id = 'your-user-uuid-here' WHERE user_id IS NULL;

-- 3. Enable Row Level Security
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- 4. Create policy to allow users to only see their own transactions
CREATE POLICY "Users can see their own transactions" 
ON transactions 
FOR SELECT 
USING (auth.uid() = user_id);

-- 5. Create policy to allow users to insert their own transactions
CREATE POLICY "Users can insert their own transactions" 
ON transactions 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

-- 6. Create policy to allow users to update their own transactions
CREATE POLICY "Users can update their own transactions" 
ON transactions 
FOR UPDATE 
USING (auth.uid() = user_id);

-- 7. Create policy to allow users to delete their own transactions
CREATE POLICY "Users can delete their own transactions" 
ON transactions 
FOR DELETE 
USING (auth.uid() = user_id);
