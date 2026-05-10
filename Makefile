# Sentinel Premium Pricing Agent — top-level make targets (Phase 22).
# All targets run from the repo root and operate on the agent/ workspace.
# This is the only Makefile in the repo today; pnpm + anchor commands stay
# in their respective workspaces.

AGENT_DIR  := agent
AGENT_PORT ?= 8000
PYTHON     ?= python3

.PHONY: help train serve test download-data clean install

help:
	@echo "Sentinel agent targets (Phase 22):"
	@echo "  make install        Install Python dependencies into the active interpreter"
	@echo "  make train          Train XGBoost on agent/data/flight_delays_train.csv -> agent/artifacts/"
	@echo "  make serve          Start FastAPI on port \$$AGENT_PORT (default 8000)"
	@echo "  make test           Run pytest agent/tests/"
	@echo "  make download-data  Print Kaggle dataset URL + manual-download instructions"
	@echo "  make clean          Remove agent/artifacts/ and Python caches"

install:
	$(PYTHON) -m pip install -r $(AGENT_DIR)/requirements.txt

train:
	cd $(AGENT_DIR) && $(PYTHON) -m training.train

serve:
	cd $(AGENT_DIR) && $(PYTHON) -m uvicorn app.main:app --host 0.0.0.0 --port $(AGENT_PORT)

test:
	cd $(AGENT_DIR) && $(PYTHON) -m pytest -v

download-data:
	@echo "Kaggle dataset: flight-delays-fall-2018"
	@echo "URL: https://www.kaggle.com/competitions/flight-delays-fall-2018/data"
	@echo ""
	@echo "Steps:"
	@echo "  1. Sign in to Kaggle (free account)."
	@echo "  2. Download flight_delays_train.csv.zip (~3 MB)."
	@echo "  3. Unzip into agent/data/flight_delays_train.csv."
	@echo "  4. Run: make train"
	@echo ""
	@echo "Kaggle ToS prevents an automated curl without auth — manual download is required."

clean:
	rm -rf $(AGENT_DIR)/artifacts/*
	find $(AGENT_DIR) -type d -name "__pycache__" -exec rm -rf {} +
	find $(AGENT_DIR) -type d -name ".pytest_cache" -exec rm -rf {} +
	@echo "Cleaned agent/artifacts/ and Python caches."
