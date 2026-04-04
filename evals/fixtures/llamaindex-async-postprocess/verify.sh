#!/usr/bin/env bash
set -euo pipefail

cd llama-index-core

# Activate venv
source .venv/bin/activate 2>/dev/null || true
export PATH=".venv/bin:$PATH"

# Verify that async postprocessors are called in async code paths.
# We test two patterns:
# 1. Inline async loop (e.g. ContextChatEngine._aget_nodes)
# 2. Sync helper delegation (e.g. RetrieverTool.acall)
python3 -c "
import asyncio
import warnings
warnings.filterwarnings('ignore', category=DeprecationWarning)
from pydantic import ConfigDict
from llama_index.core.postprocessor.types import BaseNodePostprocessor
from llama_index.core.schema import NodeWithScore, TextNode, QueryBundle

class AsyncOnlyPostprocessor(BaseNodePostprocessor):
    \"\"\"Postprocessor that only works correctly in async mode.\"\"\"
    _async_called: bool = False

    model_config = ConfigDict(arbitrary_types_allowed=True)

    def _postprocess_nodes(self, nodes, query_bundle=None, **kwargs):
        # Sync path: return nodes unmodified (wrong behavior if called in async context)
        return nodes

    async def _apostprocess_nodes(self, nodes, query_bundle=None, **kwargs):
        # Async path: mark as called and prefix content
        self._async_called = True
        result = []
        for node in nodes:
            new_node = NodeWithScore(
                node=TextNode(text='async_' + node.get_content()),
                score=node.score,
            )
            result.append(new_node)
        return result

async def test_apostprocess_nodes_called():
    proc = AsyncOnlyPostprocessor()
    nodes = [NodeWithScore(node=TextNode(text='hello'), score=1.0)]

    # Call the async public method
    result = await proc.apostprocess_nodes(nodes, query_bundle=QueryBundle(query_str='test'))

    assert proc._async_called, 'apostprocess_nodes should have been called'
    assert result[0].get_content().startswith('async_'), f'Expected async prefix, got: {result[0].get_content()}'
    print('PASS: apostprocess_nodes correctly calls async implementation')

asyncio.run(test_apostprocess_nodes_called())
"

# Check that key async methods use apostprocess_nodes instead of postprocess_nodes
echo ""
echo "Checking source files for async postprocessor usage..."

ERRORS=0

# Pattern: in async methods, postprocess_nodes should not be called directly
# (it should be apostprocess_nodes)
for f in \
    llama_index/core/chat_engine/condense_plus_context.py \
    llama_index/core/chat_engine/context.py \
    llama_index/core/chat_engine/multi_modal_condense_plus_context.py \
    llama_index/core/query_engine/citation_query_engine.py; do
    # Check if any async method still calls postprocess_nodes (sync) instead of apostprocess_nodes
    if grep -n 'postprocess_nodes\b' "$f" | grep -v 'apostprocess_nodes\|def.*postprocess\|#\|import\|_apply_node_postprocessors\|_async_apply' > /dev/null 2>&1; then
        # Might be a sync method legitimately calling it — check if it's inside an async def
        if python3 -c "
import ast, sys
with open('$f') as fh:
    tree = ast.parse(fh.read())
for node in ast.walk(tree):
    if isinstance(node, (ast.AsyncFunctionDef,)):
        for child in ast.walk(node):
            if isinstance(child, ast.Attribute) and child.attr == 'postprocess_nodes':
                print(f'FAIL: {\"$f\"}:{child.lineno} — async method calls sync postprocess_nodes')
                sys.exit(1)
" 2>/dev/null; then
            :
        else
            echo "FAIL: $f still calls sync postprocess_nodes in async context"
            ERRORS=$((ERRORS + 1))
        fi
    fi
done

# Check helper-delegation pattern files have async helpers
for f in \
    llama_index/core/chat_engine/multi_modal_context.py \
    llama_index/core/query_engine/multi_modal.py \
    llama_index/core/tools/retriever_tool.py; do
    if ! grep -q '_async_apply_node_postprocessors\|apostprocess_nodes' "$f" 2>/dev/null; then
        echo "FAIL: $f missing async postprocessor path"
        ERRORS=$((ERRORS + 1))
    fi
done

if [ "$ERRORS" -eq 0 ]; then
    echo "PASS: All async code paths use async postprocessor methods"
else
    echo "FAIL: $ERRORS files still use sync postprocessors in async paths"
    exit 1
fi

echo ""
echo "All checks passed."
