# update_worker.py
import json
import subprocess
import os
from pathlib import Path
import sys

def generate_system_prompt(context_file='claude_context.json'):
    """Generate the system prompt for Claude using the extracted context"""
    with open(context_file, 'r', encoding='utf-8') as f:
        context = json.load(f)
    
    system_prompt = f"""You are a helpful assistant embedded on Keane Lucas's academic website (keanelucas.com). 
    You have detailed knowledge of his research, publications, and background.

    Research Areas:
    {', '.join(context['research_summary'])}

    Key Publications:
    {chr(10).join(f'- {pub["title"]}: {pub["summary"][:200]}...' for pub in context['publications'])}

    Projects:
    {chr(10).join(f'- {proj["title"]}: {proj["summary"][:200]}...' for proj in context['projects'])}

    Background:
    {json.dumps(context['personal_info'], indent=2)}

    Instructions:
    1. Answer questions specifically about Keane's research, publications, projects, and background
    2. Use the provided summaries and details to give accurate, specific answers
    3. If asked about something not covered in the context, politely explain that you can only discuss Keane's academic work and research
    4. When discussing papers, use their actual titles and accurate summaries
    5. Always maintain a professional, academic tone appropriate for a research website

    Remember: You are representing an academic website. Keep responses focused on research, publications, and professional topics."""

    return system_prompt

def update_worker(prompt):
    """Update the Cloudflare Worker with the new system prompt"""
    print("Starting worker update...")
    
    worker_code = f'''
    export default {{
      async fetch(request, env) {{
        const corsHeaders = {{
          'Access-Control-Allow-Origin': 'https://keanelucas.com',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }};

        if (request.method === 'OPTIONS') {{
          return new Response(null, {{ headers: corsHeaders }});
        }}

        try {{
          const body = await request.json();
          
          const systemPrompt = {json.dumps(prompt)};
          
          const messages = [
            {{
              role: "system",
              content: systemPrompt
            }},
            ...body.messages
          ];

          const response = await fetch('https://api.anthropic.com/v1/messages', {{
            method: 'POST',
            headers: {{
              'Content-Type': 'application/json',
              'x-api-key': env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
            }},
            body: JSON.stringify({{
              model: 'claude-3-haiku-20240307',
              max_tokens: 1024,
              messages: messages
            }})
          }});

          const data = await response.json();
          
          return new Response(JSON.stringify(data), {{
            headers: {{
              'Content-Type': 'application/json',
              ...corsHeaders
            }}
          }});
        }} catch (error) {{
          return new Response(JSON.stringify({{ 
            error: 'Internal Server Error',
            details: error.message 
          }}), {{
            status: 500,
            headers: {{
              'Content-Type': 'application/json',
              ...corsHeaders
            }}
          }});
        }}
      }}
    }};
    '''
    
    try:
        print("Writing worker.js...")
        with open('worker.js', 'w') as f:
            f.write(worker_code)
        print("Successfully wrote worker.js")
        
        print("Deploying with wrangler...")
        # Run wrangler with environment variables passed through
        env = os.environ.copy()
        result = subprocess.run(
            ['wrangler', 'deploy'],
            env=env,
            text=True,
            capture_output=True
        )
        
        print("Deployment output:")
        print(result.stdout)
        
        if result.stderr:
            print("Deployment errors:")
            print(result.stderr)
        
        if result.returncode != 0:
            raise subprocess.CalledProcessError(result.returncode, ['wrangler', 'deploy'])
            
        print("Deploy successful!")
        return True
        
    except Exception as e:
        print(f"Error during deployment: {str(e)}")
        raise

if __name__ == "__main__":
    try:
        print("Starting update process...")
        system_prompt = generate_system_prompt()
        update_worker(system_prompt)
    except Exception as e:
        print(f"Fatal error: {e}")
        sys.exit(1)