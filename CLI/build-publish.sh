#!/bin/bash

# PDFStract - Build and Upload to PyPI
# This script builds the wheel distribution and uploads to PyPI

set -e

echo "🚀 InboxPie PyPI Build & Upload Script"
echo "========================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "pyproject.toml" ]; then
    echo -e "${RED}✗ Error: pyproject.toml not found${NC}"
    echo "Please run this script from the project root directory"
    exit 1
fi

# Parse arguments
UPLOAD=false
TEST_PYPI=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --upload)
            UPLOAD=true
            shift
            ;;
        --test)
            TEST_PYPI=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --upload      Upload to PyPI after building"
            echo "  --test        Upload to TestPyPI instead of PyPI"
            echo "  --dry-run     Build only, don't upload"
            echo "  --help        Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Step 1: Clean previous builds
echo -e "${YELLOW}Step 1: Cleaning previous builds...${NC}"
if [ -d "build" ]; then
    rm -rf build
    echo "✓ Removed build/ directory"
fi
if [ -d "dist" ]; then
    rm -rf dist
    echo "✓ Removed dist/ directory"
fi
if [ -d "*.egg-info" ]; then
    rm -rf *.egg-info
    echo "✓ Removed .egg-info directories"
fi
echo ""

# Step 2: Check dependencies
echo -e "${YELLOW}Step 2: Checking build dependencies...${NC}"
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}✗ python3 not found${NC}"
    exit 1
fi
echo "✓ Python found: $(python3 --version)"

# Check if build tools are installed
python3 -c "import build" 2>/dev/null || {
    echo -e "${YELLOW}Installing build tools...${NC}"
    pip install --upgrade build twine
}
echo ""

# Step 3: Build the distribution
echo -e "${YELLOW}Step 3: Building wheel distribution...${NC}"
python3 -m build
echo -e "${GREEN}✓ Build complete!${NC}"
echo ""

# Show built files
echo "Built distributions:"
ls -lh dist/
echo ""

# Step 4: Check the distribution
echo -e "${YELLOW}Step 4: Checking distribution with twine...${NC}"
python3 -m twine check dist/*
echo -e "${GREEN}✓ Distribution check passed!${NC}"
echo ""

# Step 5: Optional upload
if [ "$DRY_RUN" = true ]; then
    echo -e "${GREEN}✓ Dry run complete. Use --upload to publish to PyPI${NC}"
    exit 0
fi

if [ "$UPLOAD" = true ] || [ "$TEST_PYPI" = true ]; then
    echo -e "${YELLOW}Step 5: Uploading to PyPI...${NC}"
    
    if [ "$TEST_PYPI" = true ]; then
        echo "Uploading to TestPyPI (test.pypi.org)..."
        python3 -m twine upload --repository testpypi dist/*
        echo -e "${GREEN}✓ Upload to TestPyPI complete!${NC}"
        echo ""
        echo "Test the package with:"
        echo "  pip install -i https://test.pypi.org/simple/ pdfstract"
    else
        echo "Uploading to PyPI (pypi.org)..."
        python3 -m twine upload dist/*
        echo -e "${GREEN}✓ Upload to PyPI complete!${NC}"
        echo ""
        echo "Install the package with:"
        echo "  pip install pdfstract"
    fi
else
    echo -e "${YELLOW}Build complete! To upload to PyPI, run:${NC}"
    echo ""
    echo "  # Test upload (TestPyPI):"
    echo "  $0 --upload --test"
    echo ""
    echo "  # Production upload (PyPI):"
    echo "  $0 --upload"
    echo ""
    echo -e "${YELLOW}Or manually upload with:${NC}"
    echo "  python3 -m twine upload dist/*"
fi

