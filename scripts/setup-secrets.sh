#!/bin/bash

# Setup script for GitHub repository secrets
# Run this script to set up required secrets for CI/CD

echo "Setting up GitHub repository secrets..."

# Check if GitHub CLI is installed
if ! command -v gh &> /dev/null; then
    echo "GitHub CLI is not installed. Please install it first:"
    echo "https://cli.github.com/"
    exit 1
fi

# Check if user is authenticated
if ! gh auth status &> /dev/null; then
    echo "Please authenticate with GitHub CLI first:"
    echo "gh auth login"
    exit 1
fi

echo "Please provide the following secrets:"

# Database credentials
read -p "Database URL (production): " DATABASE_URL

# Set the secrets
echo "Setting GitHub repository secrets..."

gh secret set DATABASE_URL --body "$DATABASE_URL"

echo "Secrets have been set successfully!"
echo ""
echo "Additional secrets you may want to set:"
echo "- SLACK_WEBHOOK_URL (for notifications)"
echo "- DEPLOYMENT_KEY (for deployment access)"
echo "- API_KEYS (for external services)"
echo ""
echo "Note: Docker images are automatically pushed to GitHub Container Registry (ghcr.io)"
echo "No Docker Hub credentials needed!"
echo ""
echo "Use: gh secret set SECRET_NAME --body 'secret_value'"