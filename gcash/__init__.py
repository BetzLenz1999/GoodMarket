from .routes import gcash_bp


def init_gcash(app):
    """Initialize GCash Cashout module"""
    try:
        app.register_blueprint(gcash_bp)
        import logging
        logging.getLogger(__name__).info("✅ GCash Cashout module initialized")
        return True
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"❌ GCash initialization failed: {e}")
        return False


__all__ = ["gcash_bp", "init_gcash"]
