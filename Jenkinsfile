pipeline {
  agent any

  environment {
    ENVIRONMENT = 'development'
    DATABASE_URL = 'sqlite://'
    JWT_SECRET = 'jenkins-test-secret'
    COOKIE_SECURE = 'false'
    PUBLIC_URL = 'http://localhost:8000'
    BOOTSTRAP_ADMIN_EMAIL = ''
    BOOTSTRAP_ADMIN_PASSWORD = ''
  }

  stages {
    stage('Checkout') {
      steps {
        cleanWs()
        checkout scm
      }
    }

    stage('Setup Python env') {
      steps {
        sh '''
          set -eux
          if command -v python3 >/dev/null 2>&1; then
            PYTHON_BIN=python3
          else
            PYTHON_BIN=python
          fi
          "$PYTHON_BIN" -m venv .venv
          . .venv/bin/activate
          python -m pip install --upgrade pip setuptools wheel
          python -m pip install -r requirements-dev.txt
        '''
      }
    }

    stage('Install Node dependencies') {
      steps {
        sh '''
          set -eux
          npm ci
        '''
      }
    }

    stage('Lint and test') {
      steps {
        sh '''
          set -eux
          . .venv/bin/activate
          python -m ruff check .
          python -m pytest -q --maxfail=1
          npm run check
        '''
      }
    }

    stage('Docker build') {
      when {
        branch 'main'
      }
      steps {
        sh '''
          set -eux
          docker build -t attendly:${GIT_COMMIT} .
        '''
      }
    }
  }

  post {
    always {
      echo 'Pipeline finished.'
    }
    success {
      echo 'Build and tests passed.'
    }
    failure {
      echo 'Build or tests failed.'
    }
  }
}
