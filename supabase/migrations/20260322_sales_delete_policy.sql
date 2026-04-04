-- Allow anon to delete sales (for cleanup)
CREATE POLICY "Allow anon delete" ON sales FOR DELETE TO anon USING (true);
