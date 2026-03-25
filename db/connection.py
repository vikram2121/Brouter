"""
Database connection module.
Reads configuration from .env file.
"""

import os
import mysql.connector
from dotenv import load_dotenv

# Load environment variables from .env
load_dotenv()

def get_db_connection():
    """
    Get a MySQL database connection.
    
    Configuration is read from environment variables:
    - DB_HOST: localhost (default)
    - DB_PORT: 3306 (default)
    - DB_USER: root (default)
    - DB_PASSWORD: empty string (default)
    - DB_NAME: scout (default)
    
    Returns:
        mysql.connector.MySQLConnection: Active database connection
        
    Raises:
        mysql.connector.Error: If connection fails
    """
    
    config = {
        'host': os.getenv('DB_HOST', 'localhost'),
        'port': int(os.getenv('DB_PORT', '3306')),
        'user': os.getenv('DB_USER', 'root'),
        'password': os.getenv('DB_PASSWORD', ''),
        'database': os.getenv('DB_NAME', 'scout'),
    }
    
    return mysql.connector.connect(**config)
