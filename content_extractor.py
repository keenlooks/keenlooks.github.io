# content_extractor.py
import os
import json
import requests
from bs4 import BeautifulSoup
import PyPDF2
from urllib.parse import urljoin
import yaml
import frontmatter
from pathlib import Path
import re

class ContentExtractor:
    def __init__(self):
        # In GitHub Actions, the repository is checked out to the workspace directory
        self.repo_path = Path(os.getenv('GITHUB_WORKSPACE', '.'))
        self.website_url = "https://keanelucas.com"
        self.content = {
            "personal": {},
            "research": {},
            "publications": [],
            "projects": [],
            "talks": [],
            "pdf_content": {}
        }
        print(f"Initializing ContentExtractor with repo path: {self.repo_path}")

    def extract_markdown_content(self):
        """Extract content from markdown files in the repository"""
        markdown_files = list(self.repo_path.glob('**/*.md')) + list(self.repo_path.glob('**/*.markdown'))
        
        for md_file in markdown_files:
            try:
                post = frontmatter.load(md_file)
                content = post.content
                metadata = post.metadata

                # Determine content type based on file path or metadata
                if 'projects' in str(md_file):
                    self.content["projects"].append({
                        "title": metadata.get("title", ""),
                        "content": content,
                        "permalink": metadata.get("permalink", ""),
                        "metadata": metadata
                    })
                elif 'publications' in str(md_file):
                    self.content["publications"].append({
                        "title": metadata.get("title", ""),
                        "content": content,
                        "permalink": metadata.get("permalink", ""),
                        "metadata": metadata
                    })
                elif 'talks' in str(md_file):
                    self.content["talks"].append({
                        "title": metadata.get("title", ""),
                        "content": content,
                        "date": metadata.get("date", ""),
                        "metadata": metadata
                    })

            except Exception as e:
                print(f"Error processing {md_file}: {e}")

    def extract_pdf_content(self):
        """Extract content from PDFs in the repository"""
        pdf_files = list(self.repo_path.glob('**/*.pdf'))
        
        for pdf_path in pdf_files:
            try:
                with open(pdf_path, 'rb') as file:
                    pdf_reader = PyPDF2.PdfReader(file)
                    text = ""
                    for page in pdf_reader.pages:
                        text += page.extract_text() + "\n"
                    
                    # Clean and normalize the text
                    text = re.sub(r'\s+', ' ', text).strip()
                    
                    self.content["pdf_content"][pdf_path.name] = {
                        "title": pdf_path.stem,
                        "content": text,
                        "path": str(pdf_path.relative_to(self.repo_path))
                    }
            except Exception as e:
                print(f"Error processing PDF {pdf_path}: {e}")

    def extract_config_data(self):
        """Extract data from _config.yml"""
        config_path = self.repo_path / '_config.yml'
        if config_path.exists():
            with open(config_path, 'r', encoding='utf-8') as file:
                config = yaml.safe_load(file)
                self.content["personal"]["config"] = config

    def clean_text(self, text):
        """Clean and normalize text content"""
        text = re.sub(r'\s+', ' ', text).strip()
        text = re.sub(r'\[.*?\]', '', text)  # Remove markdown links
        text = re.sub(r'\(.*?\)', '', text)  # Remove markdown link targets
        return text

    def generate_claude_context(self):
        """Generate a context document for Claude"""
        context = {
            "personal_info": self.content["personal"],
            "research_summary": [],
            "publications": [{
                "title": pub["title"],
                "summary": self.clean_text(pub["content"])[:500]  # First 500 chars
            } for pub in self.content["publications"]],
            "projects": [{
                "title": proj["title"],
                "summary": self.clean_text(proj["content"])[:500]
            } for proj in self.content["projects"]],
            "talks": [{
                "title": talk["title"],
                "summary": self.clean_text(talk["content"])[:500]
            } for talk in self.content["talks"]],
            "pdf_summaries": [{
                "title": data["title"],
                "summary": self.clean_text(data["content"])[:1000]  # First 1000 chars
            } for data in self.content["pdf_content"].values()]
        }
        
        return context

    def save_context(self, output_path='claude_context.json'):
        """Save the extracted context to a JSON file"""
        self.extract_markdown_content()
        self.extract_pdf_content()
        self.extract_config_data()
        
        context = self.generate_claude_context()
        
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(context, f, indent=2, ensure_ascii=False)
        
        # Also generate a formatted text version for easy review
        with open('claude_context.txt', 'w', encoding='utf-8') as f:
            f.write("=== CLAUDE CONTEXT DOCUMENT ===\n\n")
            f.write("Personal Information:\n")
            f.write("-" * 50 + "\n")
            f.write(json.dumps(context["personal_info"], indent=2))
            f.write("\n\nPublications:\n")
            f.write("-" * 50 + "\n")
            for pub in context["publications"]:
                f.write(f"\nTitle: {pub['title']}\n")
                f.write(f"Summary: {pub['summary']}\n")
            # ... similar sections for other content types

if __name__ == "__main__":
    extractor = ContentExtractor()
    extractor.save_context()