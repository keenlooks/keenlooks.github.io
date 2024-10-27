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
        # Process publications
        pub_paths = [
            self.repo_path / '_publications',
            self.repo_path / '_posts',
            self.repo_path / 'publications'
        ]
        
        for pub_path in pub_paths:
            if pub_path.exists():
                for md_file in pub_path.glob('*.md'):
                    try:
                        post = frontmatter.load(md_file)
                        content = post.content
                        metadata = post.metadata
                        
                        full_text = f"Title: {metadata.get('title', '')}\n\n"
                        
                        # Add publication metadata
                        for key in ['abstract', 'venue', 'date', 'authors', 'citation']:
                            if metadata.get(key):
                                full_text += f"{key.title()}: {metadata[key]}\n\n"
                        
                        # Add main content
                        full_text += content
                        
                        self.content["publications"].append({
                            "title": metadata.get("title", ""),
                            "content": full_text,
                            "venue": metadata.get("venue", ""),
                            "date": metadata.get("date", ""),
                            "citation": metadata.get("citation", ""),
                            "permalink": metadata.get("permalink", ""),
                            "authors": metadata.get("authors", ""),
                            "abstract": metadata.get("abstract", "")
                        })
                        print(f"Processed publication: {metadata.get('title', '')}")
                    except Exception as e:
                        print(f"Error processing publication {md_file}: {e}")

        # Process projects
        projects_path = self.repo_path / '_projects'
        if projects_path.exists():
            for md_file in projects_path.glob('*.md'):
                try:
                    post = frontmatter.load(md_file)
                    self.content["projects"].append({
                        "title": post.metadata.get("title", ""),
                        "content": post.content,
                        "metadata": post.metadata
                    })
                    print(f"Processed project: {post.metadata.get('title', '')}")
                except Exception as e:
                    print(f"Error processing project {md_file}: {e}")

        # Process talks
        talks_path = self.repo_path / '_talks'
        if talks_path.exists():
            for md_file in talks_path.glob('*.md'):
                try:
                    post = frontmatter.load(md_file)
                    self.content["talks"].append({
                        "title": post.metadata.get("title", ""),
                        "content": post.content,
                        "date": post.metadata.get("date", ""),
                        "metadata": post.metadata
                    })
                    print(f"Processed talk: {post.metadata.get('title', '')}")
                except Exception as e:
                    print(f"Error processing talk {md_file}: {e}")

    def extract_pdf_content(self):
        """Extract content from PDFs in the repository"""
        pdf_paths = [
            self.repo_path / 'files',
            self.repo_path / 'papers',
            self.repo_path / 'publications'
        ]
        
        for pdf_path in pdf_paths:
            if pdf_path.exists():
                for pdf_file in pdf_path.glob('**/*.pdf'):
                    try:
                        with open(pdf_file, 'rb') as file:
                            pdf_reader = PyPDF2.PdfReader(file)
                            text = ""
                            for page in pdf_reader.pages:
                                text += page.extract_text() + "\n"
                            
                            # Clean and normalize the text
                            text = re.sub(r'\s+', ' ', text).strip()
                            
                            self.content["pdf_content"][pdf_file.name] = {
                                "title": pdf_file.stem,
                                "content": text,
                                "path": str(pdf_file.relative_to(self.repo_path))
                            }
                            print(f"Processed PDF: {pdf_file.name}")
                    except Exception as e:
                        print(f"Error processing PDF {pdf_file}: {e}")

    def extract_config_data(self):
        """Extract data from _config.yml"""
        config_path = self.repo_path / '_config.yml'
        if config_path.exists():
            try:
                with open(config_path, 'r', encoding='utf-8') as file:
                    config = yaml.safe_load(file)
                    self.content["personal"]["config"] = config
                    print("Processed _config.yml")
            except Exception as e:
                print(f"Error processing _config.yml: {e}")

    def generate_system_prompt(self):
        """Generate a comprehensive system prompt"""
        # Format publications with full details
        publications = "\n\n".join([
            f"Title: {pub['title']}\n" + \
            (f"Authors: {pub['authors']}\n" if pub.get('authors') else "") + \
            (f"Venue: {pub['venue']}\n" if pub.get('venue') else "") + \
            (f"Date: {pub['date']}\n" if pub.get('date') else "") + \
            (f"Abstract: {pub['abstract']}\n" if pub.get('abstract') else "") + \
            f"Content: {pub['content']}"
            for pub in self.content["publications"]
        ])

        # Format projects
        projects = "\n\n".join([
            f"Project: {proj['title']}\n{proj['content']}"
            for proj in self.content["projects"]
        ])

        # Format talks
        talks = "\n\n".join([
            f"Talk: {talk['title']}\nDate: {talk.get('date', 'N/A')}\n{talk['content']}"
            for talk in self.content["talks"]
        ])

        # Define research areas directly
        research_areas = """
        - Machine learning for malware detection
          * Adversarial ML
          * Robust ML classifiers
          * Raw binary analysis
        - Cooperative multi-agent reinforcement learning
          * Zero-shot coordination
          * Multi-agent systems
        - Robust machine learning
          * Adversarial defenses
          * Certified robustness
        - ML-based anomaly detection
          * Industrial control systems
          * Security applications
        """

        # Build the system prompt
        system_prompt = f"""You are a helpful assistant embedded on Keane Lucas's academic website (keanelucas.com). 
        You have detailed knowledge of his research, publications, and background.

        Research Areas:
        {research_areas}

        Publications:
        {publications}

        Projects:
        {projects}

        Talks:
        {talks}

        PDF Content:
        {chr(10).join(f'Document: {doc["title"]}\nSummary: {doc["content"][:1000]}...' for doc in self.content["pdf_content"].values())}

        Background:
        {json.dumps(self.content["personal"].get("config", {}), indent=2)}

        Instructions:
        1. Answer questions specifically about Keane's research, publications, projects, and background
        2. Use the provided full publication details to give comprehensive answers
        3. If asked about something not covered in the context, politely explain that you can only discuss Keane's academic work and research
        4. When discussing papers, use their actual titles and provide detailed information
        5. Always maintain a professional, academic tone appropriate for a research website
        6. When citing papers or discussing research, include relevant details such as venues, dates, and collaborators if available

        Remember: You are representing an academic website. Keep responses focused on research, publications, and professional topics."""

        return system_prompt

    def save_context(self, output_path='claude_context.json'):
        """Save the extracted context to a JSON file"""
        print("Starting content extraction...")
        self.extract_markdown_content()
        self.extract_pdf_content()
        self.extract_config_data()
        
        print("Generating system prompt...")
        context = self.generate_system_prompt()
        
        print(f"Saving context to {output_path}...")
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump({"system_prompt": context}, f, indent=2, ensure_ascii=False)
        
        # Also save a readable version
        text_path = 'claude_context.txt'
        print(f"Saving readable version to {text_path}...")
        with open(text_path, 'w', encoding='utf-8') as f:
            f.write(context)
        
        print("Content extraction complete!")

if __name__ == "__main__":
    extractor = ContentExtractor()
    extractor.save_context()