cd /c/Users/lyman/tradseee
echo "=== HEAD"
git log -1 --pretty=format:'%h %s'
echo ""
echo "=== typecheck"
npx tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS" | head -5
echo "typecheck-done"
