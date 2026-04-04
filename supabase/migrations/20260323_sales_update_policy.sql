CREATE POLICY "Allow anon update" ON sales FOR UPDATE TO anon USING (true) WITH CHECK (true);
