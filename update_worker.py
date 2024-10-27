# update_worker.py
import json
import subprocess
import os
from pathlib import Path

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
    worker_name = os.getenv('CLOUDFLARE_WORKER_NAME', 'claude-chat')
    
    worker_template = f'''
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

          // Use the ANTHROPIC_API_KEY from Worker environment
          const response = await fetch('https://api.anthropic.com/v1/messages', {{
            method: 'POST',
            headers: {{
              'Content-Type': 'application/json',
              'x-api-key': env.ANTHROPIC_API_KEY,  // This comes from Worker environment
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
    
    # Create wrangler.toml
    wrangler_config = f"""
    name = "{worker_name}"
    main = "worker.js"
    compatibility_date = "2024-03-26"
    """
    
    with open('wrangler.toml', 'w') as f:
        f.write(wrangler_config)
    
    # Save the worker code
    with open('worker.js', 'w') as f:
        f.write(worker_template)
    
    # Deploy using wrangler
    try:
        result = subprocess.run(
            ['wrangler', 'deploy'], 
            capture_output=True, 
            text=True,
            check=True
        )
        print("Deploy output:", result.stdout)
    except subprocess.CalledProcessError as e:
        print("Deploy error:", e.stderr)
        raise

if __name__ == "__main__":
    system_prompt = generate_system_prompt()
    update_worker(system_prompt)